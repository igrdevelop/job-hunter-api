import { ConfigService } from '@nestjs/config';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { TrackerService } from './tracker.service';

describe('TrackerService.updateField sheets_dirty', () => {
  const userId = 'user-1';
  const liveId = 'live1234';
  const orphanId = 'orph5678';

  let dir: string;
  let service: TrackerService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tracker-sheets-'));
    const trackerPath = join(dir, 'tracker.db');
    const appPath = join(dir, 'app.sqlite');

    const seed = new Database(trackerPath);
    seed.exec(`
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
        app_status TEXT NOT NULL DEFAULT ''
      );
    `);
    const insert = seed.prepare(
      `INSERT INTO applications (id, user_id, company, sheets_row, sheets_dirty)
       VALUES (?, ?, 'Acme', ?, 0)`,
    );
    insert.run(liveId, userId, 12);
    insert.run(orphanId, userId, null);
    seed.close();

    const config = {
      get: (key: string) => {
        if (key === 'tracker.dbPath') return trackerPath;
        if (key === 'app.dbPath') return appPath;
        return undefined;
      },
    } as unknown as ConfigService;

    service = new TrackerService(config);
  });

  afterEach(() => {
    service?.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function rowState(id: string): {
    sent: string;
    to_learn: string;
    app_status: string;
    sheets_row: number | null;
    sheets_dirty: number;
  } {
    return service.db
      .prepare(
        `SELECT sent, to_learn, app_status, sheets_row, sheets_dirty
         FROM applications WHERE id = ?`,
      )
      .get(id) as {
      sent: string;
      to_learn: string;
      app_status: string;
      sheets_row: number | null;
      sheets_dirty: number;
    };
  }

  it('marks sheets_dirty when a mirrored column is patched on a live sheet row', () => {
    service.updateSent(userId, liveId, '13 08');
    expect(rowState(liveId)).toMatchObject({ sent: '13 08', sheets_dirty: 1 });
  });

  it('does not mark sheets_dirty when app_status is patched', () => {
    service.updateAppStatus(userId, liveId, 'interview');
    expect(rowState(liveId)).toMatchObject({
      app_status: 'interview',
      sheets_dirty: 0,
    });
  });

  it('does not mark sheets_dirty when sheets_row is null', () => {
    service.updateSent(userId, orphanId, '13 08');
    expect(rowState(orphanId)).toMatchObject({
      sent: '13 08',
      sheets_row: null,
      sheets_dirty: 0,
    });
  });
});
