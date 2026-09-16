import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { runMigrations } from '../db/migrations';

export interface ProfileRow {
  json: string;
  schemaVersion: number;
  revision: number;
  updatedAt: string;
}

export interface RevisionSummary {
  rev: number;
  createdAt: string;
}

export interface RevisionRow {
  json: string;
  createdAt: string;
}

export interface UploadRow {
  id: string;
  filename: string;
  sha256: string;
  storedPath: string;
  jobId: string;
  createdAt: string;
}

// Keep the last N revisions per user (docs/RESUME_PROFILE_STORE.md).
const KEEP_REVISIONS = 20;

@Injectable()
export class ProfilesRepository {
  private db: Database.Database;

  constructor(private readonly config: ConfigService) {
    const dbPath = this.config.get<string>('app.dbPath')!;
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    runMigrations(this.db);
  }

  get(userId: string): ProfileRow | undefined {
    return this.db
      .prepare(
        `SELECT json, schema_version as schemaVersion, revision, updated_at as updatedAt
         FROM profiles WHERE user_id = ?`,
      )
      .get(userId) as ProfileRow | undefined;
  }

  /**
   * Upsert the profile document and append a revision snapshot, pruning
   * anything past the last KEEP_REVISIONS in the same transaction — a lost
   * job or crash between these two writes would otherwise leave revisions
   * that don't match what's live, or an unbounded revisions table.
   */
  upsertProfile(
    userId: string,
    json: string,
    schemaVersion: number,
  ): { revision: number; updatedAt: string } {
    const run = this.db.transaction(() => {
      const existing = this.db
        .prepare('SELECT revision FROM profiles WHERE user_id = ?')
        .get(userId) as { revision: number } | undefined;
      const revision = (existing?.revision ?? 0) + 1;
      const updatedAt = new Date().toISOString();

      this.db
        .prepare(
          `INSERT INTO profiles (user_id, json, schema_version, revision, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET
             json = excluded.json,
             schema_version = excluded.schema_version,
             revision = excluded.revision,
             updated_at = excluded.updated_at`,
        )
        .run(userId, json, schemaVersion, revision, updatedAt);

      this.db
        .prepare(
          `INSERT INTO profile_revisions (user_id, rev, json, created_at) VALUES (?, ?, ?, ?)`,
        )
        .run(userId, revision, json, updatedAt);

      this.db
        .prepare(
          `DELETE FROM profile_revisions
           WHERE user_id = ? AND rev NOT IN (
             SELECT rev FROM profile_revisions WHERE user_id = ? ORDER BY rev DESC LIMIT ?
           )`,
        )
        .run(userId, userId, KEEP_REVISIONS);

      return { revision, updatedAt };
    });
    return run();
  }

  listRevisions(userId: string): RevisionSummary[] {
    return this.db
      .prepare(
        `SELECT rev, created_at as createdAt FROM profile_revisions
         WHERE user_id = ? ORDER BY rev DESC`,
      )
      .all(userId) as RevisionSummary[];
  }

  getRevision(userId: string, rev: number): RevisionRow | undefined {
    return this.db
      .prepare(
        `SELECT json, created_at as createdAt FROM profile_revisions
         WHERE user_id = ? AND rev = ?`,
      )
      .get(userId, rev) as RevisionRow | undefined;
  }

  /**
   * Record one upload's durable metadata at POST /api/profile/uploads time
   * (docs/PROFILE_PAGE_TABS.md T2). This row is the only place the original
   * client filename survives — the parse job's `result` column belongs to
   * the bot's output once the job completes.
   */
  insertUpload(row: {
    id: string;
    userId: string;
    filename: string;
    sha256: string;
    storedPath: string;
    jobId: string;
  }): { createdAt: string } {
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO profile_uploads (id, user_id, filename, sha256, stored_path, job_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.userId,
        row.filename,
        row.sha256,
        row.storedPath,
        row.jobId,
        createdAt,
      );
    return { createdAt };
  }

  listUploads(userId: string): UploadRow[] {
    // `rowid` breaks ties for uploads landing in the same millisecond —
    // same reasoning as ProfileService.getLastRenderJob's ordering.
    return this.db
      .prepare(
        `SELECT id, filename, sha256, stored_path as storedPath,
                job_id as jobId, created_at as createdAt
         FROM profile_uploads WHERE user_id = ?
         ORDER BY created_at DESC, rowid DESC`,
      )
      .all(userId) as UploadRow[];
  }

  /** Right-to-erasure (docs/RESUME_PROFILE_STORE.md): wipe all three tables. */
  deleteAllForUser(userId: string): void {
    const run = this.db.transaction(() => {
      this.db.prepare('DELETE FROM profiles WHERE user_id = ?').run(userId);
      this.db
        .prepare('DELETE FROM profile_revisions WHERE user_id = ?')
        .run(userId);
      this.db
        .prepare('DELETE FROM profile_uploads WHERE user_id = ?')
        .run(userId);
    });
    run();
  }
}
