import Database from 'better-sqlite3';

type Migration = { version: number; up: (db: Database.Database) => void };

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up(db) {
      // Add role/email_verified/disabled to users; promote existing rows to admin.
      db.exec(`
        ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user';
        ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0;
        UPDATE users SET role = 'admin', email_verified = 1;
      `);
    },
  },
];

export function runMigrations(db: Database.Database): void {
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
