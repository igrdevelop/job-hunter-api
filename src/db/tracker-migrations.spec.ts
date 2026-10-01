import { ConfigService } from '@nestjs/config';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { TrackerService } from '../tracker/tracker.service';
import { USERS_SCHEMA } from './migrations';
import { runTrackerMigrations, USER_URL_INDEX } from './tracker-migrations';

// A pre-multi-user applications table, as the bot wrote it before B1: no
// user_id, and only a NON-unique url_norm index, so duplicates were legal.
const LEGACY_SCHEMA = `
  CREATE TABLE applications (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL DEFAULT '',
    company TEXT NOT NULL DEFAULT '',
    ats_status TEXT NOT NULL DEFAULT '',
    url_norm TEXT NOT NULL DEFAULT '',
    sent TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX idx_url_norm ON applications(url_norm) WHERE url_norm != '';
`;

function columns(db: Database.Database): string[] {
  return (
    db.prepare('PRAGMA table_info(applications)').all() as { name: string }[]
  ).map((r) => r.name);
}

function hasIndex(db: Database.Database, name: string): boolean {
  return (
    db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?`)
      .get(name) !== undefined
  );
}

function legacyDb(rows: [string, string][]): Database.Database {
  const db = new Database(':memory:');
  db.exec(LEGACY_SCHEMA);
  const insert = db.prepare(
    `INSERT INTO applications (id, url_norm) VALUES (?, ?)`,
  );
  for (const [id, url] of rows) insert.run(id, url);
  return db;
}

describe('runTrackerMigrations — user scope', () => {
  it('adds user_id, gives legacy rows to the owner and creates the unique index', () => {
    const db = legacyDb([
      ['a', 'https://x/1'],
      ['b', 'https://x/2'],
      ['c', ''],
    ]);
    runTrackerMigrations(db, 'owner-1');

    expect(columns(db)).toContain('user_id');
    expect(
      db.prepare(`SELECT DISTINCT user_id FROM applications`).all(),
    ).toEqual([{ user_id: 'owner-1' }]);
    expect(hasIndex(db, USER_URL_INDEX)).toBe(true);
    expect(hasIndex(db, 'idx_url_norm')).toBe(false);
    db.close();
  });

  it('refuses duplicate url_norm rows loudly and rolls every step back', () => {
    const db = legacyDb([
      ['a', 'https://x/dup'],
      ['b', 'https://x/dup'],
      ['c', 'https://x/3'],
    ]);

    expect(() => runTrackerMigrations(db, 'owner-1')).toThrow(
      /1 duplicate group\(s\)[\s\S]*https:\/\/x\/dup \(2 rows\)[\s\S]*never deletes/,
    );

    // Nothing half-applied: no user_id, no API columns, legacy index kept,
    // and no row deleted.
    const cols = columns(db);
    expect(cols).not.toContain('user_id');
    expect(cols).not.toContain('app_status');
    expect(hasIndex(db, 'idx_url_norm')).toBe(true);
    expect(hasIndex(db, USER_URL_INDEX)).toBe(false);
    expect(
      (
        db.prepare(`SELECT COUNT(*) AS c FROM applications`).get() as {
          c: number;
        }
      ).c,
    ).toBe(3);

    // A second run fails the same way instead of "succeeding" on a
    // half-migrated schema.
    expect(() => runTrackerMigrations(db, 'owner-1')).toThrow(/duplicate/);
    db.close();
  });

  it('heals a half-migrated DB (user_id present, unique index missing)', () => {
    const db = legacyDb([['a', 'https://x/1']]);
    db.exec(
      `ALTER TABLE applications ADD COLUMN user_id TEXT NOT NULL DEFAULT ''`,
    );
    runTrackerMigrations(db, 'owner-1');
    expect(hasIndex(db, USER_URL_INDEX)).toBe(true);
    db.close();
  });

  it('deferUserScope leaves user_id alone but runs every other step', () => {
    const db = legacyDb([['a', 'https://x/1']]);
    runTrackerMigrations(db, '', { deferUserScope: true });
    const cols = columns(db);
    expect(cols).not.toContain('user_id');
    expect(cols).toContain('app_status');
    db.close();
  });
});

describe('TrackerService — owner backfill on a fresh app.sqlite', () => {
  let dir: string;
  let trackerPath: string;
  let appPath: string;
  let service: TrackerService | undefined;

  function config(ownerUserId = ''): ConfigService {
    return {
      get: (key: string) => {
        if (key === 'tracker.dbPath') return trackerPath;
        if (key === 'app.dbPath') return appPath;
        if (key === 'owner.userId') return ownerUserId;
        return undefined;
      },
    } as unknown as ConfigService;
  }

  function addUser(id: string, role: string, createdAt: string): void {
    const app = new Database(appPath);
    app.exec(USERS_SCHEMA);
    app
      .prepare(
        `INSERT INTO users (id, email, password, role, created_at) VALUES (?, ?, 'x', ?, ?)`,
      )
      .run(id, `${id}@test.local`, role, createdAt);
    app.close();
  }

  function owners(): string[] {
    return (
      service!.db
        .prepare(`SELECT DISTINCT user_id FROM applications ORDER BY user_id`)
        .all() as { user_id: string }[]
    ).map((r) => r.user_id);
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tracker-owner-'));
    trackerPath = join(dir, 'tracker.db');
    appPath = join(dir, 'app.sqlite');
    const seed = new Database(trackerPath);
    seed.exec(LEGACY_SCHEMA);
    seed.exec(
      `INSERT INTO applications (id, url_norm) VALUES ('a', 'https://x/1'), ('b', 'https://x/2')`,
    );
    seed.close();
  });

  afterEach(() => {
    service?.db.close();
    service = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  it('waits for the owner seeded after construction (AuthService.onModuleInit)', () => {
    // No app.sqlite yet: the constructor must not stamp user_id = ''.
    service = new TrackerService(config());
    expect(columns(service.db)).not.toContain('user_id');

    addUser('seeded-admin', 'admin', '2026-01-01 00:00:00');
    service.onApplicationBootstrap();

    expect(owners()).toEqual(['seeded-admin']);
    expect(hasIndex(service.db, USER_URL_INDEX)).toBe(true);
  });

  it("still migrates (user_id = '') when no owner exists by bootstrap", () => {
    service = new TrackerService(config());
    service.onApplicationBootstrap();
    expect(owners()).toEqual(['']);
  });

  it('migrates in the constructor when the owner already exists', () => {
    addUser('admin-1', 'admin', '2026-01-01 00:00:00');
    service = new TrackerService(config());
    expect(owners()).toEqual(['admin-1']);
  });

  it('picks the oldest admin when OWNER_USER_ID is unset', () => {
    addUser('admin-new', 'admin', '2026-05-01 00:00:00');
    addUser('admin-old', 'admin', '2026-01-01 00:00:00');
    service = new TrackerService(config());
    expect(owners()).toEqual(['admin-old']);
  });

  it('honours OWNER_USER_ID over role when that account exists', () => {
    addUser('admin-1', 'admin', '2026-01-01 00:00:00');
    addUser('owner-user', 'user', '2026-02-01 00:00:00');
    service = new TrackerService(config('owner-user'));
    expect(owners()).toEqual(['owner-user']);
  });

  it('never hands the rows to a stale OWNER_USER_ID', () => {
    addUser('admin-1', 'admin', '2026-01-01 00:00:00');
    service = new TrackerService(config('deleted-account'));
    service.onApplicationBootstrap();
    expect(owners()).toEqual(['']);
  });
});
