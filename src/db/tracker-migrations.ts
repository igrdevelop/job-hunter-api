import Database from 'better-sqlite3';

/**
 * Idempotent migrations for tracker.db (bot's shared DB). Safe to run whether
 * the bot has already applied them or not. TrackerService runs this at startup.
 */
export function runTrackerMigrations(
  trackerDb: Database.Database,
  ownerUserId: string,
): void {
  const cols = (
    trackerDb.prepare('PRAGMA table_info(applications)').all() as {
      name: string;
    }[]
  ).map((r) => r.name);

  // The bot owns the applications table; on a fresh tracker.db it may not
  // exist yet (PRAGMA returns no rows). Skip — this runs again on next start.
  if (cols.length > 0 && !cols.includes('user_id')) {
    trackerDb.exec(
      `ALTER TABLE applications ADD COLUMN user_id TEXT NOT NULL DEFAULT ''`,
    );
    if (ownerUserId) {
      trackerDb
        .prepare(`UPDATE applications SET user_id = ? WHERE user_id = ''`)
        .run(ownerUserId);
    }
    trackerDb.exec(`
      DROP INDEX IF EXISTS idx_url_norm;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_user_url_norm
        ON applications(user_id, url_norm) WHERE url_norm != '';
      CREATE INDEX IF NOT EXISTS idx_user_ats
        ON applications(user_id, ats_status);
    `);
  }

  // Manual application status set from the web UI (dropdown). The bot never
  // reads or writes it; defaulted so the bot's explicit-column INSERTs are safe.
  if (cols.length > 0 && !cols.includes('app_status')) {
    trackerDb.exec(
      `ALTER TABLE applications ADD COLUMN app_status TEXT NOT NULL DEFAULT ''`,
    );
  }

  // These tables are always created idempotently regardless of user_id column.
  trackerDb.exec(`
    CREATE TABLE IF NOT EXISTS user_settings (
      user_id TEXT NOT NULL,
      key     TEXT NOT NULL,
      value   TEXT NOT NULL DEFAULT '',
      updated_at TEXT,
      PRIMARY KEY (user_id, key)
    );

    CREATE TABLE IF NOT EXISTS telegram_links (
      chat_id  INTEGER PRIMARY KEY,
      user_id  TEXT UNIQUE NOT NULL,
      linked_at TEXT
    );

    CREATE TABLE IF NOT EXISTS telegram_link_codes (
      code       TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    -- Render/parse handoff to the bot (docs/RESUME_PROFILE_STORE.md P2/P3).
    -- Same precedent as telegram_link_codes: API writes, bot consumes.
    CREATE TABLE IF NOT EXISTS profile_jobs (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      kind       TEXT NOT NULL,
      payload    TEXT NOT NULL DEFAULT '',
      status     TEXT NOT NULL DEFAULT 'pending',
      result     TEXT NOT NULL DEFAULT '',
      error      TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_profile_jobs_status
      ON profile_jobs(status, created_at);
  `);
}
