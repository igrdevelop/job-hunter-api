import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runTrackerMigrations } from '../db/tracker-migrations';
import { UpdateApplicationDto } from './dto/update.dto';
import { TrackerService } from './tracker.service';

// Base schema: mirrors the bot's applications table plus the two API-owned
// columns (app_status, note). Deliberately WITHOUT outcome_label/outcome_at
// — that's the bot-owned column pair (docs/improvement-2026-09/
// 08-DATA_EVAL_PLAN.md M1) this API must tolerate being absent.
const BASE_SCHEMA = `
  CREATE TABLE applications (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL DEFAULT '',
    user_id TEXT NOT NULL DEFAULT '',
    company TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    stack TEXT NOT NULL DEFAULT '',
    ats_status TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL DEFAULT '',
    url_norm TEXT NOT NULL DEFAULT '',
    folder TEXT NOT NULL DEFAULT '',
    sent TEXT NOT NULL DEFAULT '',
    reapplication TEXT NOT NULL DEFAULT '',
    to_learn TEXT NOT NULL DEFAULT '',
    drive_url TEXT NOT NULL DEFAULT '',
    confirmation TEXT NOT NULL DEFAULT '',
    answer TEXT NOT NULL DEFAULT '',
    sheets_row INTEGER,
    sheets_dirty INTEGER NOT NULL DEFAULT 0,
    fail_count INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL,
    ats_verdict REAL,
    app_status TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT ''
  );
`;

// Extended schema: same as above, plus the bot-owned outcome columns — used
// by the describe block that exercises outcome derivation.
const SCHEMA_WITH_OUTCOME = `
  CREATE TABLE applications (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL DEFAULT '',
    user_id TEXT NOT NULL DEFAULT '',
    company TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    stack TEXT NOT NULL DEFAULT '',
    ats_status TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL DEFAULT '',
    url_norm TEXT NOT NULL DEFAULT '',
    folder TEXT NOT NULL DEFAULT '',
    sent TEXT NOT NULL DEFAULT '',
    reapplication TEXT NOT NULL DEFAULT '',
    to_learn TEXT NOT NULL DEFAULT '',
    drive_url TEXT NOT NULL DEFAULT '',
    confirmation TEXT NOT NULL DEFAULT '',
    answer TEXT NOT NULL DEFAULT '',
    sheets_row INTEGER,
    sheets_dirty INTEGER NOT NULL DEFAULT 0,
    fail_count INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL,
    ats_verdict REAL,
    app_status TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    outcome_label TEXT NOT NULL DEFAULT '',
    outcome_at TEXT
  );
`;

function makeService(schema: string): {
  service: TrackerService;
  dir: string;
  trackerPath: string;
} {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-sheets-'));
  const trackerPath = join(dir, 'tracker.db');
  const appPath = join(dir, 'app.sqlite');

  const seed = new Database(trackerPath);
  seed.exec(schema);
  const insert = seed.prepare(
    `INSERT INTO applications (id, user_id, company, sent, sheets_row, sheets_dirty)
     VALUES (?, ?, 'Acme', ?, ?, 0)`,
  );
  insert.run('live1234', 'user-1', '', 12);
  insert.run('orph5678', 'user-1', '', null);
  insert.run('other0001', 'user-2', '', 34);
  seed.close();

  const config = {
    get: (key: string) => {
      if (key === 'tracker.dbPath') return trackerPath;
      if (key === 'app.dbPath') return appPath;
      return undefined;
    },
  } as unknown as ConfigService;

  return { service: new TrackerService(config), dir, trackerPath };
}

describe('TrackerService.updateApplication', () => {
  const userId = 'user-1';
  const liveId = 'live1234';
  const orphanId = 'orph5678';
  const otherUserId = 'other0001';

  let dir: string;
  let service: TrackerService;

  beforeEach(() => {
    const made = makeService(BASE_SCHEMA);
    service = made.service;
    dir = made.dir;
  });

  afterEach(() => {
    service?.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function rowState(id: string): {
    sent: string;
    to_learn: string;
    reapplication: string;
    app_status: string;
    note: string;
    sheets_row: number | null;
    sheets_dirty: number;
  } {
    return service.db
      .prepare(
        `SELECT sent, to_learn, reapplication, app_status, note, sheets_row, sheets_dirty
         FROM applications WHERE id = ?`,
      )
      .get(id) as {
      sent: string;
      to_learn: string;
      reapplication: string;
      app_status: string;
      note: string;
      sheets_row: number | null;
      sheets_dirty: number;
    };
  }

  it('marks sheets_dirty when a mirrored column is patched on a live sheet row', () => {
    service.updateApplication(userId, liveId, { sent: '13 08' });
    expect(rowState(liveId)).toMatchObject({ sent: '13 08', sheets_dirty: 1 });
  });

  it('does not mark sheets_dirty when app_status is patched with a blank status', () => {
    // '' derives nothing, so this only exercises the plain column write.
    service.updateApplication(userId, liveId, { appStatus: '' });
    expect(rowState(liveId)).toMatchObject({
      app_status: '',
      sheets_dirty: 0,
    });
  });

  it('does not mark sheets_dirty when sheets_row is null', () => {
    service.updateApplication(userId, orphanId, { sent: '13 08' });
    expect(rowState(orphanId)).toMatchObject({
      sent: '13 08',
      sheets_row: null,
      sheets_dirty: 0,
    });
  });

  it('marks sheets_dirty when reapplication is patched on a live sheet row', () => {
    service.updateApplication(userId, liveId, { reapplication: '14 08' });
    expect(rowState(liveId)).toMatchObject({
      reapplication: '14 08',
      sheets_dirty: 1,
    });
  });

  it('does not mark sheets_dirty when reapplication is patched and sheets_row is null', () => {
    service.updateApplication(userId, orphanId, { reapplication: '14 08' });
    expect(rowState(orphanId)).toMatchObject({
      reapplication: '14 08',
      sheets_row: null,
      sheets_dirty: 0,
    });
  });

  it('saves a note and never dirties the sheet row', () => {
    service.updateApplication(userId, liveId, {
      note: 'wrong stack, skipping',
    });
    expect(rowState(liveId)).toMatchObject({
      note: 'wrong stack, skipping',
      sheets_dirty: 0,
    });
  });

  it('round-trips a note through the read path', () => {
    service.updateApplication(userId, liveId, {
      note: 'reason: relocation only',
    });
    const app = service.getApplicationById(userId, liveId);
    expect(app?.note).toBe('reason: relocation only');
  });

  it('does not dirty the sheet row for a note even when sheets_row is set', () => {
    service.updateApplication(userId, liveId, { note: 'anything' });
    expect(rowState(liveId).sheets_dirty).toBe(0);
  });

  describe('appStatus derivation onto sent', () => {
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Warsaw',
    }).format(new Date());

    it.each(['Sent', 'Interview', 'Rejected', 'Offer', 'Silence'])(
      'fills a blank sent with today for an applied status (%s)',
      (status) => {
        service.updateApplication(userId, liveId, { appStatus: status });
        expect(rowState(liveId).sent).toBe(today);
      },
    );

    it.each(['-', '—', '–'])(
      'overwrites a dash marker (%s) with today for an applied status',
      (dash) => {
        service.db
          .prepare(`UPDATE applications SET sent = ? WHERE id = ?`)
          .run(dash, liveId);
        service.updateApplication(userId, liveId, { appStatus: 'Sent' });
        expect(rowState(liveId).sent).toBe(today);
      },
    );

    it('never overwrites a real date already in sent', () => {
      service.db
        .prepare(`UPDATE applications SET sent = ? WHERE id = ?`)
        .run('2026-01-15', liveId);
      service.updateApplication(userId, liveId, { appStatus: 'Interview' });
      expect(rowState(liveId).sent).toBe('2026-01-15');
    });

    it('never overwrites EXPIRED already in sent', () => {
      service.db
        .prepare(`UPDATE applications SET sent = ? WHERE id = ?`)
        .run('EXPIRED', liveId);
      service.updateApplication(userId, liveId, { appStatus: 'Offer' });
      expect(rowState(liveId).sent).toBe('EXPIRED');
    });

    it('never overwrites old free text already in sent', () => {
      service.db
        .prepare(`UPDATE applications SET sent = ? WHERE id = ?`)
        .run('не тот стек', liveId);
      service.updateApplication(userId, liveId, { appStatus: 'Sent' });
      expect(rowState(liveId).sent).toBe('не тот стек');
    });

    it.each(['Skipped', 'Filter miss'])(
      'fills a blank sent with a dash marker for a not-applying status (%s)',
      (status) => {
        service.updateApplication(userId, liveId, { appStatus: status });
        expect(rowState(liveId).sent).toBe('—');
      },
    );

    it('does not overwrite an existing dash with another dash for a not-applying status', () => {
      service.db
        .prepare(`UPDATE applications SET sent = ? WHERE id = ?`)
        .run('-', liveId);
      service.updateApplication(userId, liveId, { appStatus: 'Skipped' });
      expect(rowState(liveId).sent).toBe('-');
    });

    it('never overwrites a real date for a not-applying status', () => {
      service.db
        .prepare(`UPDATE applications SET sent = ? WHERE id = ?`)
        .run('2026-02-02', liveId);
      service.updateApplication(userId, liveId, { appStatus: 'Filter miss' });
      expect(rowState(liveId).sent).toBe('2026-02-02');
    });

    it('a blank status derives nothing', () => {
      service.updateApplication(userId, liveId, { appStatus: '' });
      expect(rowState(liveId).sent).toBe('');
    });

    it('derives without crashing when tracker.db lacks outcome_label/outcome_at', () => {
      expect(() =>
        service.updateApplication(userId, liveId, { appStatus: 'Interview' }),
      ).not.toThrow();
      expect(rowState(liveId).sent).toBe(today);
    });

    it('an explicit sent in the same body suppresses derivation entirely', () => {
      service.updateApplication(userId, liveId, {
        sent: 'restored-value',
        appStatus: 'Sent',
      });
      expect(rowState(liveId).sent).toBe('restored-value');
    });

    it('derived sent write on an applied status still marks sheets_dirty when sheets_row is set', () => {
      service.updateApplication(userId, liveId, { appStatus: 'Sent' });
      expect(rowState(liveId).sheets_dirty).toBe(1);
    });

    it('derived sent write does not mark sheets_dirty when sheets_row is null', () => {
      service.updateApplication(userId, orphanId, { appStatus: 'Sent' });
      expect(rowState(orphanId)).toMatchObject({
        sent: today,
        sheets_dirty: 0,
      });
    });
  });

  it('throws NotFoundException and writes nothing for an unknown id', () => {
    expect(() =>
      service.updateApplication(userId, 'doesnotexist', { note: 'x' }),
    ).toThrow(NotFoundException);
  });

  it("throws NotFoundException and writes nothing for another user's row", () => {
    expect(() =>
      service.updateApplication(userId, otherUserId, { note: 'x' }),
    ).toThrow(NotFoundException);
    // Untouched: still readable by its real owner, note still blank.
    const app = service.getApplicationById('user-2', otherUserId);
    expect(app?.note).toBe('');
  });
});

describe('TrackerService.updateApplication outcome derivation (schema with outcome columns)', () => {
  const userId = 'user-1';
  const liveId = 'live1234';
  const orphanId = 'orph5678';

  let dir: string;
  let service: TrackerService;

  beforeEach(() => {
    const made = makeService(SCHEMA_WITH_OUTCOME);
    service = made.service;
    dir = made.dir;
  });

  afterEach(() => {
    service?.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function outcomeState(id: string): {
    outcome_label: string;
    outcome_at: string | null;
    sheets_dirty: number;
  } {
    return service.db
      .prepare(
        `SELECT outcome_label, outcome_at, sheets_dirty FROM applications WHERE id = ?`,
      )
      .get(id) as {
      outcome_label: string;
      outcome_at: string | null;
      sheets_dirty: number;
    };
  }

  it.each([
    ['Interview', 'interview'],
    ['Rejected', 'rejected'],
    ['Offer', 'offer'],
    ['Silence', 'silence'],
  ])(
    'sets outcome_label + stamps outcome_at for status %s',
    (status, label) => {
      service.updateApplication(userId, liveId, { appStatus: status });
      const state = outcomeState(liveId);
      expect(state.outcome_label).toBe(label);
      expect(state.outcome_at).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
      );
    },
  );

  it('does not set an outcome for the plain Sent status', () => {
    service.updateApplication(userId, liveId, { appStatus: 'Sent' });
    expect(outcomeState(liveId).outcome_label).toBe('');
  });

  it('dirties the sheet row for an outcome write when sheets_row is set', () => {
    service.updateApplication(userId, liveId, { appStatus: 'Interview' });
    expect(outcomeState(liveId).sheets_dirty).toBe(1);
  });

  it('does not dirty the sheet row for an outcome write when sheets_row is null', () => {
    service.updateApplication(userId, orphanId, { appStatus: 'Interview' });
    expect(outcomeState(orphanId)).toMatchObject({
      outcome_label: 'interview',
      sheets_dirty: 0,
    });
  });

  it('does not re-stamp outcome_at when the same outcome is set again', () => {
    service.updateApplication(userId, liveId, { appStatus: 'Interview' });
    const first = outcomeState(liveId).outcome_at;

    service.updateApplication(userId, liveId, { appStatus: 'Interview' });
    const second = outcomeState(liveId).outcome_at;

    expect(second).toBe(first);
  });

  it('never clears an outcome when the status moves back to blank', () => {
    service.updateApplication(userId, liveId, { appStatus: 'Rejected' });
    expect(outcomeState(liveId).outcome_label).toBe('rejected');

    service.updateApplication(userId, liveId, { appStatus: '' });
    expect(outcomeState(liveId).outcome_label).toBe('rejected');
  });

  it('never clears an outcome when the status moves back to Sent', () => {
    service.updateApplication(userId, liveId, { appStatus: 'Offer' });
    expect(outcomeState(liveId).outcome_label).toBe('offer');

    service.updateApplication(userId, liveId, { appStatus: 'Sent' });
    expect(outcomeState(liveId).outcome_label).toBe('offer');
  });

  it('suppresses outcome derivation too when the body also sends an explicit sent', () => {
    service.updateApplication(userId, liveId, {
      sent: 'restored-value',
      appStatus: 'Interview',
    });
    expect(outcomeState(liveId).outcome_label).toBe('');
  });
});

describe('runTrackerMigrations idempotency', () => {
  it('running the migration twice does not throw and leaves one note/app_status column', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tracker-migrate-'));
    const trackerPath = join(dir, 'tracker.db');
    try {
      const db = new Database(trackerPath);
      // user_id/url_norm/ats_status already present (as on any tracker.db
      // that already went through the earlier user_id migration) so this
      // test isolates the note/app_status idempotency guard, not the
      // unrelated user_id/index migration branch.
      db.exec(`
        CREATE TABLE applications (
          id TEXT PRIMARY KEY,
          sent TEXT NOT NULL DEFAULT '',
          user_id TEXT NOT NULL DEFAULT '',
          url_norm TEXT NOT NULL DEFAULT '',
          ats_status TEXT NOT NULL DEFAULT ''
        );
      `);

      expect(() => runTrackerMigrations(db, 'owner-1')).not.toThrow();
      expect(() => runTrackerMigrations(db, 'owner-1')).not.toThrow();

      const cols = (
        db.prepare('PRAGMA table_info(applications)').all() as {
          name: string;
        }[]
      ).map((r) => r.name);
      expect(cols.filter((c) => c === 'note')).toHaveLength(1);
      expect(cols.filter((c) => c === 'app_status')).toHaveLength(1);
      db.close();
    } finally {
      // Windows can briefly hold the file handle right after close(); retry
      // instead of flaking.
      rmSync(dir, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
    }
  });
});

describe('UpdateApplicationDto validation', () => {
  it('accepts a known appStatus value', async () => {
    const dto = plainToInstance(UpdateApplicationDto, {
      appStatus: 'Interview',
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('rejects an unknown appStatus value', async () => {
    const dto = plainToInstance(UpdateApplicationDto, { appStatus: 'Bogus' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'appStatus')).toBe(true);
  });

  it('rejects a note longer than 2000 characters', async () => {
    const dto = plainToInstance(UpdateApplicationDto, {
      note: 'x'.repeat(2001),
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'note')).toBe(true);
  });
});
