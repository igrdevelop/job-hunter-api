import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { TrackerService } from '../tracker/tracker.service';
import { ProfilesRepository } from './profile.db';
import { SUPPORTED_SCHEMA_VERSION, validateProfile } from './profile-validate';

export interface ProfileGetResponse {
  profile: Record<string, unknown>;
  revision: number;
  updatedAt: string;
}

export interface ProfilePutResponse {
  revision: number;
  renderJobId: string;
}

export interface ProfileJobResponse {
  kind: string;
  status: string;
  result?: string;
  error?: string;
}

interface ProfileJobRow {
  kind: string;
  status: string;
  result: string;
  error: string;
}

@Injectable()
export class ProfileService {
  constructor(
    private readonly repo: ProfilesRepository,
    private readonly tracker: TrackerService,
  ) {}

  get(userId: string): ProfileGetResponse {
    const row = this.repo.get(userId);
    if (!row) {
      throw new NotFoundException('Profile not found');
    }
    return {
      profile: JSON.parse(row.json) as Record<string, unknown>,
      revision: row.revision,
      updatedAt: row.updatedAt,
    };
  }

  put(userId: string, body: unknown): ProfilePutResponse {
    const result = validateProfile(body);
    if (!result.ok) {
      throw new BadRequestException({ errors: result.errors });
    }

    const json = JSON.stringify(result.value);
    const { revision } = this.repo.upsertProfile(
      userId,
      json,
      SUPPORTED_SCHEMA_VERSION,
    );
    const renderJobId = this.createRenderJob(userId, json);
    return { revision, renderJobId };
  }

  listRevisions(userId: string) {
    return this.repo.listRevisions(userId);
  }

  restore(userId: string, rev: number): ProfilePutResponse {
    if (!Number.isInteger(rev) || rev <= 0) {
      throw new BadRequestException('Invalid revision');
    }
    const row = this.repo.getRevision(userId, rev);
    if (!row) {
      throw new NotFoundException(`Revision ${rev} not found`);
    }

    // Content was already validated when it was first written — restoring
    // it re-applies a trusted snapshot, not new client input.
    const parsed = JSON.parse(row.json) as Record<string, unknown>;
    const schemaVersion =
      typeof parsed.schema_version === 'number'
        ? parsed.schema_version
        : SUPPORTED_SCHEMA_VERSION;
    const { revision } = this.repo.upsertProfile(
      userId,
      row.json,
      schemaVersion,
    );
    const renderJobId = this.createRenderJob(userId, row.json);
    return { revision, renderJobId };
  }

  getJob(userId: string, id: string): ProfileJobResponse {
    const row = this.tracker.db
      .prepare(
        `SELECT kind, status, result, error FROM profile_jobs WHERE id = ? AND user_id = ?`,
      )
      .get(id, userId) as ProfileJobRow | undefined;
    if (!row) {
      throw new NotFoundException(`Job ${id} not found`);
    }

    const response: ProfileJobResponse = {
      kind: row.kind,
      status: row.status,
    };
    if (row.result) response.result = row.result;
    if (row.error) response.error = row.error;
    return response;
  }

  /**
   * Self-contained payload (the full profile JSON) — the bot never reads
   * app.sqlite, so this row alone is enough for its drain job to render.
   * No cross-DB transaction with the profiles upsert above (better-sqlite3
   * transactions are per-connection): a lost job just means the next PUT
   * creates a fresh one, and rendering is idempotent full-overwrite
   * (docs/RESUME_PROFILE_STORE.md "Risks / decisions").
   */
  private createRenderJob(userId: string, payload: string): string {
    const id = randomUUID();
    this.tracker.db
      .prepare(
        `INSERT INTO profile_jobs (id, user_id, kind, payload, status, created_at)
         VALUES (?, ?, 'render', ?, 'pending', ?)`,
      )
      .run(id, userId, payload, new Date().toISOString());
    return id;
  }
}
