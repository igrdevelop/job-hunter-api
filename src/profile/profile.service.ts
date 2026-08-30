import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { mkdirSync, writeFileSync } from 'fs';
import { basename, join } from 'path';
import { TrackerService } from '../tracker/tracker.service';
import { UserPathsService } from '../users/user-paths.service';
import { ProfilesRepository } from './profile.db';
import { ALLOWED_UPLOAD_EXTENSIONS, extensionOf } from './profile-upload';
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
    private readonly userPaths: UserPathsService,
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
    const renderJobId = this.createJob(userId, 'render', json);
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
    const renderJobId = this.createJob(userId, 'render', row.json);
    return { revision, renderJobId };
  }

  /**
   * Store the raw upload under uploads/ (never user-browsable — only the
   * bot's parse job reads it) and hand off a parse job. The stored filename
   * is always `{uuid}.{ext}`; the client's original filename never touches
   * the filesystem path, so a hostile name (e.g. containing `..`) is inert —
   * it only ever appears, basename'd, as display metadata on the job row.
   */
  uploadResume(
    userId: string,
    file: Express.Multer.File | undefined,
  ): { jobId: string } {
    if (!file?.buffer?.length) {
      throw new BadRequestException('Empty file');
    }
    const ext = extensionOf(file.originalname);
    if (!ALLOWED_UPLOAD_EXTENSIONS.has(ext)) {
      throw new BadRequestException(`Unsupported file type: .${ext || '?'}`);
    }

    const uploadId = randomUUID();
    const fileName = `${uploadId}.${ext}`;
    const dir = this.userPaths.uploadsDir(userId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, fileName), file.buffer);

    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    const metadata = JSON.stringify({
      filename: basename(file.originalname),
      sha256,
    });

    const jobId = this.createJob(
      userId,
      'parse',
      `uploads/${fileName}`,
      metadata,
    );
    return { jobId };
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
   * Self-contained payload (the full profile JSON for 'render', the
   * uploads/-relative path for 'parse') — the bot never reads app.sqlite,
   * so this row alone is enough for its drain job. No cross-DB transaction
   * with the app.sqlite writes above (better-sqlite3 transactions are
   * per-connection): a lost job just means the next PUT/upload creates a
   * fresh one (docs/RESUME_PROFILE_STORE.md "Risks / decisions").
   */
  private createJob(
    userId: string,
    kind: 'render' | 'parse',
    payload: string,
    result = '',
  ): string {
    const id = randomUUID();
    this.tracker.db
      .prepare(
        `INSERT INTO profile_jobs (id, user_id, kind, payload, status, result, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(id, userId, kind, payload, result, new Date().toISOString());
    return id;
  }
}
