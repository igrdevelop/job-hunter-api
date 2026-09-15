import { BadRequestException, NotFoundException } from '@nestjs/common';
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

// Base schema: mirrors the bot's applications table plus the API-owned
// columns (app_status, owner_reason, owner_reason_note). Deliberately
// WITHOUT outcome_label/outcome_at — that's the bot-owned column pair
// (docs/improvement-2026-09/08-DATA_EVAL_PLAN.md M1) this API must tolerate
// being absent.
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
    owner_reason TEXT NOT NULL DEFAULT '',
    owner_reason_note TEXT NOT NULL DEFAULT ''
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
    owner_reason TEXT NOT NULL DEFAULT '',
    owner_reason_note TEXT NOT NULL DEFAULT '',
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
    owner_reason: string;
    owner_reason_note: string;
    sheets_row: number | null;
    sheets_dirty: number;
  } {
    return service.db
      .prepare(
        `SELECT sent, to_learn, reapplication, app_status, owner_reason, owner_reason_note, sheets_row, sheets_dirty
         FROM applications WHERE id = ?`,
      )
      .get(id) as {
      sent: string;
      to_learn: string;
      reapplication: string;
      app_status: string;
      owner_reason: string;
      owner_reason_note: string;
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

  describe('ownerReason / ownerReasonNote', () => {
    it('saves an owner reason + note on a Skipped row', () => {
      service.updateApplication(userId, liveId, {
        appStatus: 'Skipped',
        ownerReason: 'stack',
        ownerReasonNote: 'heavy backend, not a fit',
      });
      expect(rowState(liveId)).toMatchObject({
        app_status: 'Skipped',
        owner_reason: 'stack',
        owner_reason_note: 'heavy backend, not a fit',
      });
    });

    it('round-trips ownerReason/ownerReasonNote through the read path', () => {
      service.updateApplication(userId, liveId, {
        appStatus: 'Filter miss',
        ownerReason: 'location',
        ownerReasonNote: '3 days in Kraków',
      });
      const app = service.getApplicationById(userId, liveId);
      expect(app?.ownerReason).toBe('location');
      expect(app?.ownerReasonNote).toBe('3 days in Kraków');
    });

    it("accepts a reason allowed for the row's CURRENT status when appStatus is absent from the body", () => {
      service.updateApplication(userId, liveId, { appStatus: 'Skipped' });
      service.updateApplication(userId, liveId, { ownerReason: 'salary' });
      expect(rowState(liveId).owner_reason).toBe('salary');
    });

    it('rejects a reason not allowed for Filter miss (Skipped-only code) with 400 and writes nothing', () => {
      expect(() =>
        service.updateApplication(userId, liveId, {
          appStatus: 'Filter miss',
          ownerReason: 'salary',
        }),
      ).toThrow(BadRequestException);
      expect(rowState(liveId)).toMatchObject({
        app_status: '',
        owner_reason: '',
        sent: '',
      });
    });

    it('rejects a non-empty reason when the resulting status is not Skipped/Filter miss', () => {
      expect(() =>
        service.updateApplication(userId, liveId, {
          appStatus: 'Sent',
          ownerReason: 'stack',
        }),
      ).toThrow(BadRequestException);
      expect(rowState(liveId)).toMatchObject({
        app_status: '',
        sent: '',
        owner_reason: '',
      });
    });

    it('rejects a non-empty reason against the current status when the body has no appStatus at all', () => {
      // current app_status is '' (never Skipped/Filter miss) by default.
      expect(() =>
        service.updateApplication(userId, liveId, { ownerReason: 'stack' }),
      ).toThrow(BadRequestException);
      expect(rowState(liveId).owner_reason).toBe('');
    });

    it('allows an empty ownerReason regardless of the resulting status (explicit clear)', () => {
      expect(() =>
        service.updateApplication(userId, liveId, {
          appStatus: 'Sent',
          ownerReason: '',
        }),
      ).not.toThrow();
    });

    it('clears both reason fields when appStatus moves to a non-decline value', () => {
      service.updateApplication(userId, liveId, {
        appStatus: 'Skipped',
        ownerReason: 'duplicate',
        ownerReasonNote: 'seen before',
      });
      service.updateApplication(userId, liveId, { appStatus: 'Sent' });
      expect(rowState(liveId)).toMatchObject({
        owner_reason: '',
        owner_reason_note: '',
      });
    });

    it('clears both reason fields when appStatus is explicitly reset to blank', () => {
      service.updateApplication(userId, liveId, {
        appStatus: 'Skipped',
        ownerReason: 'other',
        ownerReasonNote: 'misc',
      });
      service.updateApplication(userId, liveId, { appStatus: '' });
      expect(rowState(liveId)).toMatchObject({
        owner_reason: '',
        owner_reason_note: '',
      });
    });

    it('drops a lone ownerReasonNote patched onto a non-decline row', () => {
      service.updateApplication(userId, liveId, { appStatus: 'Sent' });
      service.updateApplication(userId, liveId, { ownerReasonNote: 'orphan' });
      expect(rowState(liveId)).toMatchObject({
        app_status: 'Sent',
        owner_reason: '',
        owner_reason_note: '',
      });
    });

    it('does not touch reason fields when appStatus stays a decline status and the body omits reason', () => {
      service.updateApplication(userId, liveId, {
        appStatus: 'Skipped',
        ownerReason: 'level',
        ownerReasonNote: 'too senior',
      });
      // Re-send the same decline status without mentioning the reason at all.
      service.updateApplication(userId, liveId, { appStatus: 'Skipped' });
      expect(rowState(liveId)).toMatchObject({
        owner_reason: 'level',
        owner_reason_note: 'too senior',
      });
    });

    it('a reason-only PATCH on an already-Skipped row works without re-sending appStatus', () => {
      service.updateApplication(userId, liveId, { appStatus: 'Skipped' });
      service.updateApplication(userId, liveId, {
        ownerReason: 'russia',
        ownerReasonNote: 'RU market',
      });
      expect(rowState(liveId)).toMatchObject({
        app_status: 'Skipped',
        owner_reason: 'russia',
        owner_reason_note: 'RU market',
      });
    });

    it('never dirties the sheet row for owner_reason/owner_reason_note even when sheets_row is set', () => {
      // Pre-fill sent with a real date so the appStatus derivation step has
      // nothing to overwrite — isolates the reason fields' own dirty
      // behavior from the (separately tested) mirrored `sent` derivation.
      service.db
        .prepare(`UPDATE applications SET sent = ? WHERE id = ?`)
        .run('2026-01-01', liveId);
      service.updateApplication(userId, liveId, { appStatus: 'Skipped' });
      expect(rowState(liveId).sheets_dirty).toBe(0);

      service.updateApplication(userId, liveId, {
        ownerReason: 'expired',
        ownerReasonNote: 'listing gone',
      });
      expect(rowState(liveId)).toMatchObject({
        owner_reason: 'expired',
        owner_reason_note: 'listing gone',
        sheets_dirty: 0,
      });
    });

    it('clears a stale owner_reason left invalid by a status change, keeping the note, when the body omits ownerReason', () => {
      // 'salary' is Skipped-only. Move Skipped -> Filter miss WITHOUT
      // mentioning ownerReason at all: the row must not keep an invalid
      // reason/status combination just because Filter miss is still a
      // decline status (the unconditional "moved off decline" reset never
      // fires here, since Filter miss IS a decline status).
      service.updateApplication(userId, liveId, {
        appStatus: 'Skipped',
        ownerReason: 'salary',
        ownerReasonNote: 'below range',
      });
      service.updateApplication(userId, liveId, { appStatus: 'Filter miss' });
      expect(rowState(liveId)).toMatchObject({
        app_status: 'Filter miss',
        owner_reason: '',
        owner_reason_note: 'below range',
      });
    });

    it('leaves a still-valid stored reason untouched across a decline-to-decline status change', () => {
      // Sanity check for the same code path: a reason that's allowed for
      // BOTH decline statuses must survive Skipped -> Filter miss.
      service.updateApplication(userId, liveId, {
        appStatus: 'Skipped',
        ownerReason: 'duplicate',
        ownerReasonNote: 'seen before',
      });
      service.updateApplication(userId, liveId, { appStatus: 'Filter miss' });
      expect(rowState(liveId)).toMatchObject({
        app_status: 'Filter miss',
        owner_reason: 'duplicate',
        owner_reason_note: 'seen before',
      });
    });

    it('rejects an explicit contradiction — ownerReason "" with a non-empty ownerReasonNote in the same body — and writes nothing', () => {
      service.updateApplication(userId, liveId, {
        appStatus: 'Skipped',
        ownerReason: 'stack',
        ownerReasonNote: 'heavy backend',
      });
      expect(() =>
        service.updateApplication(userId, liveId, {
          ownerReason: '',
          ownerReasonNote: 'still relevant somehow',
        }),
      ).toThrow(BadRequestException);
      // Unchanged: the contradiction is rejected before any write happens.
      expect(rowState(liveId)).toMatchObject({
        owner_reason: 'stack',
        owner_reason_note: 'heavy backend',
      });
    });

    it('allows clearing ownerReason alone (no ownerReasonNote in the body) without 400, leaving the stored note as-is', () => {
      service.updateApplication(userId, liveId, {
        appStatus: 'Skipped',
        ownerReason: 'stack',
        ownerReasonNote: 'heavy backend',
      });
      expect(() =>
        service.updateApplication(userId, liveId, { ownerReason: '' }),
      ).not.toThrow();
      expect(rowState(liveId)).toMatchObject({
        owner_reason: '',
        owner_reason_note: 'heavy backend',
      });
    });

    it('allows ownerReason "" together with ownerReasonNote "" (both explicitly cleared)', () => {
      service.updateApplication(userId, liveId, {
        appStatus: 'Skipped',
        ownerReason: 'stack',
        ownerReasonNote: 'heavy backend',
      });
      expect(() =>
        service.updateApplication(userId, liveId, {
          ownerReason: '',
          ownerReasonNote: '',
        }),
      ).not.toThrow();
      expect(rowState(liveId)).toMatchObject({
        owner_reason: '',
        owner_reason_note: '',
      });
    });
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

    describe('Clear (appStatus "") undoes a mis-clicked decline', () => {
      it.each(['Skipped', 'Filter miss'])(
        'clears the dash sent marker this API wrote when undoing a %s',
        (status) => {
          service.updateApplication(userId, liveId, { appStatus: status });
          expect(rowState(liveId).sent).toBe('—'); // the marker this API just derived
          service.updateApplication(userId, liveId, { appStatus: '' });
          expect(rowState(liveId).sent).toBe('');
        },
      );

      it('does not touch a bot-written dash sent when the row was never a decline appStatus', () => {
        // Simulates the bot's own SKIP/FAIL dash stamp on a row whose
        // web-only appStatus was never set to a decline value — that dash
        // must not resurface the row in Unsent just because someone clicked
        // Clear on an unrelated status.
        service.db
          .prepare(`UPDATE applications SET sent = ? WHERE id = ?`)
          .run('—', liveId);
        service.updateApplication(userId, liveId, { appStatus: '' });
        expect(rowState(liveId).sent).toBe('—');
      });

      it('does not touch a bot-written dash sent even when the row WAS marked Skipped (ats_status is the bot SKIP/FAIL stamp)', () => {
        // The scenario `previousStatus` alone can't distinguish: the bot
        // stamps '—' at INSERT time (ats_status='SKIP'), before this API's
        // appStatus is ever touched. The owner later marks it 'Skipped' here
        // too (sent was already non-blank, so nothing changes), then clicks
        // Clear. Without the ats_status provenance check, this used to wipe
        // the bot's own dash and resurface the row in Unsent.
        service.db
          .prepare(
            `UPDATE applications SET sent = ?, ats_status = ? WHERE id = ?`,
          )
          .run('—', 'SKIP', liveId);
        service.updateApplication(userId, liveId, { appStatus: 'Skipped' });
        expect(rowState(liveId).sent).toBe('—');
        service.updateApplication(userId, liveId, { appStatus: '' });
        expect(rowState(liveId).sent).toBe('—');
      });

      it('still clears the dash on a normal (non-bot-SKIP/FAIL) row when Clear undoes a Skipped', () => {
        // ats_status here is a real ATS score, never touched by this API —
        // the dash in `sent` can only have come from this API's own
        // NOT_APPLYING derivation, so Clear is free to undo it.
        service.db
          .prepare(`UPDATE applications SET ats_status = ? WHERE id = ?`)
          .run('85%', liveId);
        service.updateApplication(userId, liveId, { appStatus: 'Skipped' });
        expect(rowState(liveId).sent).toBe('—');
        service.updateApplication(userId, liveId, { appStatus: '' });
        expect(rowState(liveId).sent).toBe('');
      });

      it('does not touch a real sent date when Clear undoes a decline status', () => {
        service.updateApplication(userId, liveId, { appStatus: 'Skipped' });
        service.db
          .prepare(`UPDATE applications SET sent = ? WHERE id = ?`)
          .run('2026-01-01', liveId);
        service.updateApplication(userId, liveId, { appStatus: '' });
        expect(rowState(liveId).sent).toBe('2026-01-01');
      });

      it('does not touch sent at all when the body includes an explicit sent alongside appStatus ""', () => {
        service.updateApplication(userId, liveId, { appStatus: 'Skipped' });
        expect(rowState(liveId).sent).toBe('—');
        service.updateApplication(userId, liveId, {
          appStatus: '',
          sent: 'restored-value',
        });
        expect(rowState(liveId).sent).toBe('restored-value');
      });

      it('never touches outcome_label/outcome_at when undoing a decline status (there is nothing to derive there)', () => {
        service.updateApplication(userId, liveId, { appStatus: 'Skipped' });
        expect(() =>
          service.updateApplication(userId, liveId, { appStatus: '' }),
        ).not.toThrow();
        // No outcome columns on this schema at all — the point is simply
        // that Clear's own derivation path never calls setOutcome().
        expect(rowState(liveId).sent).toBe('');
      });

      it('the cleared sent write still marks sheets_dirty when sheets_row is set (normal dirty rule)', () => {
        service.updateApplication(userId, liveId, { appStatus: 'Skipped' });
        service.db
          .prepare(`UPDATE applications SET sheets_dirty = 0 WHERE id = ?`)
          .run(liveId);
        service.updateApplication(userId, liveId, { appStatus: '' });
        expect(rowState(liveId)).toMatchObject({ sent: '', sheets_dirty: 1 });
      });
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
      service.updateApplication(userId, 'doesnotexist', { toLearn: 'x' }),
    ).toThrow(NotFoundException);
  });

  it("throws NotFoundException and writes nothing for another user's row", () => {
    expect(() =>
      service.updateApplication(userId, otherUserId, { toLearn: 'x' }),
    ).toThrow(NotFoundException);
    // Untouched: still readable by its real owner, to_learn still blank.
    const app = service.getApplicationById('user-2', otherUserId);
    expect(app?.toLearn).toBe('');
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
      // Matches the bot's own `datetime.now(timezone.utc).isoformat(timespec="seconds")`
      // shape (`+00:00`, not a trailing `Z`) — see app-status.ts::nowIsoSeconds.
      expect(state.outcome_at).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/,
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

describe('updateApplication transaction locking (SQLITE_BUSY_SNAPSHOT regression guard)', () => {
  // updateApplication SELECTs the current row, then (conditionally) writes.
  // better-sqlite3's db.transaction() defaults to BEGIN DEFERRED, which
  // takes no lock at all until the first statement runs and fixes its read
  // snapshot at that first statement (our SELECT) — if a concurrent writer
  // (the bot process) commits between that SELECT and our own first write,
  // the write's lock-upgrade fails with SQLITE_BUSY_SNAPSHOT, which
  // busy_timeout does NOT retry (it's a snapshot conflict, not a lock wait).
  // The fix is `run.immediate()`, which issues BEGIN IMMEDIATE and so takes
  // the write lock up front, before our SELECT even runs.
  //
  // better-sqlite3 does not expose the literal BEGIN/COMMIT SQL through the
  // public `Database.prototype.prepare` (verified: only statements the
  // application itself prepares are observable that way), so the exact
  // journal mode can't be asserted by inspecting SQL text. Instead this test
  // observes the LOCK behavior directly: a second raw connection to the
  // SAME on-disk file attempts a real write at the instant our own
  // "read the current row" SELECT is prepared — i.e. strictly after
  // updateApplication's transaction has begun. With `busy_timeout = 0` on
  // that second connection (fail immediately, no retry), its write can only
  // succeed if our own transaction has NOT yet taken the write lock at that
  // point — which is exactly the DEFERRED bug. If our transaction is
  // IMMEDIATE (the fix), the write lock is already held and the second
  // connection's write throws synchronously.
  it('already holds the write lock before its own first SELECT runs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tracker-lock-'));
    const trackerPath = join(dir, 'tracker.db');
    const appPath = join(dir, 'app.sqlite');

    const seed = new Database(trackerPath);
    seed.exec(BASE_SCHEMA);
    seed
      .prepare(
        `INSERT INTO applications (id, user_id, company, sent, sheets_row, sheets_dirty)
         VALUES ('live1234', 'user-1', 'Acme', '', 12, 0)`,
      )
      .run();
    seed.close();

    const config = {
      get: (key: string) => {
        if (key === 'tracker.dbPath') return trackerPath;
        if (key === 'app.dbPath') return appPath;
        return undefined;
      },
    } as unknown as ConfigService;
    const service = new TrackerService(config);

    const second = new Database(trackerPath);
    second.pragma('journal_mode = WAL');
    second.pragma('busy_timeout = 0'); // fail fast, no retry

    let concurrentWriteThrew = false;
    // Capture the ORIGINAL bound method (not a dynamic `service.db.prepare`
    // lookup, which would re-enter the mock installed below and recurse
    // forever) with an explicit type — `.bind()` on a generic method like
    // `prepare` otherwise resolves to `any` under TS, which is what made
    // this an unsafe `any` in the first place.
    const originalPrepare = service.db.prepare.bind(service.db) as (
      sql: string,
    ) => Database.Statement;
    jest
      .spyOn(service.db, 'prepare')
      .mockImplementation((sql: string): Database.Statement => {
        if (sql.startsWith('SELECT sent, app_status, owner_reason')) {
          try {
            second
              .prepare(
                `UPDATE applications SET sent = 'concurrent' WHERE id = ?`,
              )
              .run('live1234');
          } catch {
            concurrentWriteThrew = true;
          }
        }
        return originalPrepare(sql);
      });

    try {
      service.updateApplication('user-1', 'live1234', { appStatus: 'Sent' });
      expect(concurrentWriteThrew).toBe(true);
    } finally {
      second.close();
      service.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runTrackerMigrations idempotency', () => {
  it('running the migration twice does not throw and leaves one of each new column', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tracker-migrate-'));
    const trackerPath = join(dir, 'tracker.db');
    try {
      const db = new Database(trackerPath);
      // user_id/url_norm/ats_status already present (as on any tracker.db
      // that already went through the earlier user_id migration) so this
      // test isolates the app_status/owner_reason/owner_reason_note
      // idempotency guard, not the unrelated user_id/index migration branch.
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
      expect(cols.filter((c) => c === 'app_status')).toHaveLength(1);
      expect(cols.filter((c) => c === 'owner_reason')).toHaveLength(1);
      expect(cols.filter((c) => c === 'owner_reason_note')).toHaveLength(1);
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

  it('accepts a known ownerReason value', async () => {
    const dto = plainToInstance(UpdateApplicationDto, {
      ownerReason: 'stack',
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('accepts an empty ownerReason (clear)', async () => {
    const dto = plainToInstance(UpdateApplicationDto, { ownerReason: '' });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('rejects an unknown ownerReason value', async () => {
    const dto = plainToInstance(UpdateApplicationDto, {
      ownerReason: 'bogus_code',
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'ownerReason')).toBe(true);
  });

  it('rejects an ownerReasonNote longer than 500 characters', async () => {
    const dto = plainToInstance(UpdateApplicationDto, {
      ownerReasonNote: 'x'.repeat(501),
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'ownerReasonNote')).toBe(true);
  });

  it('accepts an ownerReasonNote at exactly 500 characters', async () => {
    const dto = plainToInstance(UpdateApplicationDto, {
      ownerReasonNote: 'x'.repeat(500),
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });
});
