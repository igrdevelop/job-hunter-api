import Database from 'better-sqlite3';

// Base app.sqlite schema. Lives here (not in UsersRepository) so any
// consumer of runMigrations gets a valid `users` table before migration 1's
// ALTERs run, regardless of which repository's constructor happens to open
// the connection first — see ProfilesRepository for a second such consumer.
export const USERS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    email_verified INTEGER NOT NULL DEFAULT 0,
    disabled INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )
`;

type Migration = { version: number; up: (db: Database.Database) => void };

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up(db) {
      // Add role/email_verified/disabled to users; promote existing rows to admin.
      // A fresh DB already gets these columns from the base SCHEMA — skip then.
      const cols = (
        db.prepare('PRAGMA table_info(users)').all() as { name: string }[]
      ).map((r) => r.name);
      if (cols.includes('role')) return;
      db.exec(`
        ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user';
        ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0;
        UPDATE users SET role = 'admin', email_verified = 1;
      `);
    },
  },
  {
    version: 2,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS email_verification_tokens (
          token      TEXT PRIMARY KEY,
          user_id    TEXT NOT NULL,
          expires_at TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 3,
    up(db) {
      // Resume profile store (docs/RESUME_PROFILE_STORE.md): canonical
      // document + its revision history. Kept in app.sqlite — the bot never
      // reads this table, only the rendered files under candidate/.
      db.exec(`
        CREATE TABLE IF NOT EXISTS profiles (
          user_id        TEXT PRIMARY KEY,
          json           TEXT NOT NULL,
          schema_version INTEGER NOT NULL,
          revision       INTEGER NOT NULL DEFAULT 1,
          updated_at     TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS profile_revisions (
          user_id    TEXT NOT NULL,
          rev        INTEGER NOT NULL,
          json       TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (user_id, rev)
        );
      `);
    },
  },
  {
    version: 4,
    up(db) {
      // Durable upload metadata (docs/PROFILE_PAGE_TABS.md T2): the original
      // client filename + sha256 used to live only in profile_jobs.result,
      // which the bot's drain job overwrites with the parse output — this
      // table is written once at POST /api/profile/uploads time and never
      // touched by the bot, so the metadata survives job completion.
      // job_id points at the parse row in tracker.db's profile_jobs (no FK —
      // separate database).
      db.exec(`
        CREATE TABLE IF NOT EXISTS profile_uploads (
          id          TEXT PRIMARY KEY,
          user_id     TEXT NOT NULL,
          filename    TEXT NOT NULL,
          sha256      TEXT NOT NULL,
          stored_path TEXT NOT NULL,
          job_id      TEXT NOT NULL,
          created_at  TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_profile_uploads_user_id
          ON profile_uploads(user_id);
      `);
    },
  },
];

export function runMigrations(db: Database.Database): void {
  db.exec(USERS_SCHEMA);
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)`,
  );

  const applied = new Set<number>(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map(
      (r) => r.version,
    ),
  );

  const insert = db.prepare('INSERT INTO schema_migrations (version) VALUES (?)');

  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    db.transaction(() => {
      m.up(db);
      insert.run(m.version);
    })();
  }
}
