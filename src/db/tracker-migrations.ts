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

  if (!cols.includes('user_id')) {
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
  `);
}
