import Database from 'better-sqlite3';

/** Name of the per-user unique URL index. Shared with the bot's hunter/db.py. */
export const USER_URL_INDEX = 'idx_user_url_norm';

export interface TrackerMigrationOptions {
  /**
   * Leave the multi-user step (add `user_id`, give the legacy rows to the
   * owner, create the per-user indexes) for a later run. TrackerService sets
   * it when the column is still missing and no owner exists YET — on a fresh
   * app.sqlite the seeded admin only appears in AuthService.onModuleInit,
   * after TrackerService is constructed, so migrating then would stamp every
   * legacy row `user_id = ''` for good. The later run (onApplicationBootstrap)
   * finds the column still missing and does the whole step at once.
   */
  deferUserScope?: boolean;
}

/** True when tracker.db has an applications table without a user_id column. */
export function needsUserScopeMigration(trackerDb: Database.Database): boolean {
  const cols = applicationColumns(trackerDb);
  return cols.length > 0 && !cols.includes('user_id');
}

function applicationColumns(trackerDb: Database.Database): string[] {
  return (
    trackerDb.prepare('PRAGMA table_info(applications)').all() as {
      name: string;
    }[]
  ).map((r) => r.name);
}

/**
 * Idempotent migrations for tracker.db (bot's shared DB). Safe to run whether
 * the bot has already applied them or not. TrackerService runs this at startup.
 *
 * Runs in ONE transaction: a failure (e.g. duplicate rows blocking the unique
 * index) rolls every step back, so the next boot sees the same untouched DB
 * and fails the same way instead of "succeeding" on a half-migrated schema
 * that has user_id but no unique index. IMMEDIATE takes the write lock up
 * front, so the bot cannot change the schema between our PRAGMA read and
 * the ALTER.
 */
export function runTrackerMigrations(
  trackerDb: Database.Database,
  ownerUserId: string,
  options: TrackerMigrationOptions = {},
): void {
  trackerDb
    .transaction(() => {
      migrate(trackerDb, ownerUserId, options);
    })
    .immediate();
}

function migrate(
  trackerDb: Database.Database,
  ownerUserId: string,
  options: TrackerMigrationOptions,
): void {
  let cols = applicationColumns(trackerDb);

  // The bot owns the applications table; on a fresh tracker.db it may not
  // exist yet (PRAGMA returns no rows). Skip — this runs again on next start.
  if (cols.length > 0 && !cols.includes('user_id') && !options.deferUserScope) {
    trackerDb.exec(
      `ALTER TABLE applications ADD COLUMN user_id TEXT NOT NULL DEFAULT ''`,
    );
    if (ownerUserId) {
      trackerDb
        .prepare(`UPDATE applications SET user_id = ? WHERE user_id = ''`)
        .run(ownerUserId);
    }
    trackerDb.exec(`DROP INDEX IF EXISTS idx_url_norm`);
    cols = applicationColumns(trackerDb);
  }

  // Also heals a DB an older API left half-migrated (user_id added, unique
  // index creation failed outside a transaction). A no-op once the index
  // exists, which the bot's own init_db guarantees on every start.
  if (cols.includes('user_id')) {
    ensureUserScopeIndexes(trackerDb);
  }

  // Manual application status set from the web UI (dropdown). The bot never
  // reads or writes it; defaulted so the bot's explicit-column INSERTs are safe.
  if (cols.length > 0 && !cols.includes('app_status')) {
    trackerDb.exec(
      `ALTER TABLE applications ADD COLUMN app_status TEXT NOT NULL DEFAULT ''`,
    );
  }

  // Decline reason (category code + optional comment) for a Skipped/Filter
  // miss app_status, set from the web UI's decline dialog. API-owned like
  // app_status: never mirrored to Sheets, bot never reads or writes it, and
  // deliberately named apart from the bot's own gate-only skip_reason so the
  // two are never confused. Replaces the earlier `note` column (never
  // deployed, dropped without a migration).
  if (cols.length > 0 && !cols.includes('owner_reason')) {
    trackerDb.exec(
      `ALTER TABLE applications ADD COLUMN owner_reason TEXT NOT NULL DEFAULT ''`,
    );
  }
  if (cols.length > 0 && !cols.includes('owner_reason_note')) {
    trackerDb.exec(
      `ALTER TABLE applications ADD COLUMN owner_reason_note TEXT NOT NULL DEFAULT ''`,
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

    -- Operational commands from the /pipeline page to the bot (hunt,
    -- retry_failed, check_expired). Same precedent as profile_jobs: API
    -- writes pending rows, the bot drains them. The DDL is the shared
    -- contract (the bot's hunter/db.py carries the same statements) — never
    -- change it on one side only.
    CREATE TABLE IF NOT EXISTS bot_commands (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'pending',
      result TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT);
    CREATE INDEX IF NOT EXISTS idx_bot_commands_status ON bot_commands(status, created_at);
  `);
}

/**
 * Creates the per-user indexes (same DDL as the bot's hunter/db.py).
 *
 * Duplicate (user_id, url_norm) rows would make the unique index fail with a
 * bare "UNIQUE constraint failed". The bot resolves them by DELETING the
 * weaker rows (_dedup_url_norm in init_db); the API deliberately does not —
 * deleting a user's applications is not a side effect a web-server boot
 * should have. It refuses to start instead, naming the duplicates.
 */
function ensureUserScopeIndexes(trackerDb: Database.Database): void {
  const hasIndex = trackerDb
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?`)
    .get(USER_URL_INDEX);
  if (!hasIndex) {
    const dups = trackerDb
      .prepare(
        `SELECT user_id, url_norm, COUNT(*) AS n FROM applications
          WHERE url_norm != '' GROUP BY user_id, url_norm HAVING n > 1
          ORDER BY url_norm`,
      )
      .all() as { user_id: string; url_norm: string; n: number }[];
    if (dups.length > 0) {
      const sample = dups
        .slice(0, 5)
        .map(
          (d) =>
            `  user_id='${d.user_id}' url_norm=${d.url_norm} (${d.n} rows)`,
        )
        .join('\n');
      throw new Error(
        `tracker.db: cannot create the unique (user_id, url_norm) index — ` +
          `${dups.length} duplicate group(s):\n${sample}\n` +
          `The API never deletes tracker rows. Start the bot once (its init_db ` +
          `de-duplicates, keeping the best row per user+URL) or remove the ` +
          `duplicates by hand, then restart the API. No migration was applied.`,
      );
    }
  }
  trackerDb.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${USER_URL_INDEX}
      ON applications(user_id, url_norm) WHERE url_norm != '';
    CREATE INDEX IF NOT EXISTS idx_user_ats
      ON applications(user_id, ats_status);
  `);
}
