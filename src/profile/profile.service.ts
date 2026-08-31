import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  Stats,
} from 'fs';
import { basename, extname, join } from 'path';
import { safeJoin } from '../files/safe-path';
import { TrackerService } from '../tracker/tracker.service';
import { UserPathsService } from '../users/user-paths.service';
import {
  DEFAULT_PREVIEW_CONTENT_TYPE,
  isPathSafeComponent,
  isValidTrack,
  PREVIEW_CONTENT_TYPES,
  PreviewListItem,
} from './profile-preview';
import {
  candidateFileContentType,
  CandidateFileInfo,
  isWhitelistedCandidateFile,
  tryParseUploadMetadata,
  uploadIdFromPayload,
  UploadListItem,
} from './profile-files';
import { ProfilesRepository } from './profile.db';
import { ALLOWED_UPLOAD_EXTENSIONS, extensionOf } from './profile-upload';
import { SUPPORTED_SCHEMA_VERSION, validateProfile } from './profile-validate';

export interface LastRenderJob {
  id: string;
  status: string;
  updatedAt: string;
}

export interface ProfileGetResponse {
  profile: Record<string, unknown>;
  revision: number;
  updatedAt: string;
  lastRenderJob: LastRenderJob | null;
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
      lastRenderJob: this.getLastRenderJob(userId),
    };
  }

  /**
   * docs/PROFILE_PAGE_TABS.md T2: staleness signal for tab 3 — the site
   * compares this against the profile's own `updatedAt` to derive "changed
   * since last render", so no separate computed flag is needed here.
   */
  private getLastRenderJob(userId: string): LastRenderJob | null {
    const row = this.tracker.db
      .prepare(
        `SELECT id, status, created_at as createdAt, updated_at as updatedAt
         FROM profile_jobs WHERE user_id = ? AND kind = 'render'
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(userId) as
      | {
          id: string;
          status: string;
          createdAt: string;
          updatedAt: string | null;
        }
      | undefined;
    if (!row) return null;
    // `rowid` breaks ties when two jobs share the same `created_at` millisecond
    // (two PUTs back-to-back) — `created_at` alone isn't a stable "most recent".
    // `updated_at` is only stamped once the bot's drain job claims/finishes
    // the row (tracker-migrations.ts leaves it nullable) — a still-pending
    // job falls back to its creation time rather than surfacing `null`.
    return {
      id: row.id,
      status: row.status,
      updatedAt: row.updatedAt ?? row.createdAt,
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

  /**
   * docs/PROFILE_PAGE_TABS.md T1: queue a "what would the system actually
   * produce" preview render. The client names only a track — the payload
   * (the full current profile document) is built here from the `profiles`
   * table, never accepted from the caller, so a stale/forged profile blob
   * can never ride in on this endpoint.
   */
  preview(userId: string, body: unknown): { jobId: string } {
    const track =
      body && typeof body === 'object'
        ? (body as Record<string, unknown>).track
        : undefined;
    if (!isValidTrack(track)) {
      throw new BadRequestException(
        'track must be a lowercase slug matching ^[a-z][a-z0-9_]*$',
      );
    }

    const row = this.repo.get(userId);
    if (!row) {
      throw new ConflictException('No stored profile to preview');
    }

    const payload = JSON.stringify({
      profile: JSON.parse(row.json) as Record<string, unknown>,
      track,
    });
    const jobId = this.createJob(userId, 'preview', payload);
    return { jobId };
  }

  /**
   * Dated history (owner decision — never an overwrite): every completed
   * preview run lives in its own `preview/<track>/<timestamp>/` folder, so
   * listing is just a directory walk. Returns [] (not an error) when the
   * tree doesn't exist yet — matches every other "browse a user tree"
   * listing in this repo (GeneratedService.listDir).
   */
  listPreviews(userId: string): PreviewListItem[] {
    const root = this.userPaths.previewDir(userId);
    const items: (PreviewListItem & { mtimeMs: number })[] = [];

    for (const track of this.listDirNames(root)) {
      const trackDir = join(root, track);
      for (const timestamp of this.listDirNames(trackDir)) {
        const tsDir = join(trackDir, timestamp);
        let mtimeMs = 0;
        try {
          mtimeMs = statSync(tsDir).mtimeMs;
        } catch {
          // Directory vanished between the readdir above and this stat —
          // keep the entry, just without a reliable sort key.
        }
        items.push({
          track,
          timestamp,
          files: this.listFileNames(tsDir),
          mtimeMs,
        });
      }
    }

    items.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return items.map(({ track, timestamp, files }) => ({
      track,
      timestamp,
      files,
    }));
  }

  /**
   * Resolve one preview file for download. Every route param is validated
   * as a path-safe component BEFORE it touches the filesystem (`safeJoin`
   * re-checks the joined result as a second line of defense) — see
   * docs/PROFILE_PAGE_TABS.md "Risks / decisions": path traversal is the
   * whole game on these three new endpoints.
   */
  resolvePreviewFile(
    userId: string,
    track: string,
    timestamp: string,
    file: string,
  ): { path: string; contentType: string; inline: boolean } {
    if (
      !isValidTrack(track) ||
      !isPathSafeComponent(timestamp) ||
      !isPathSafeComponent(file)
    ) {
      throw new BadRequestException('Invalid path segment');
    }

    const path = safeJoin(
      this.userPaths.previewDir(userId),
      track,
      timestamp,
      file,
    );
    let stat: Stats;
    try {
      stat = statSync(path);
    } catch {
      throw new NotFoundException('File not found');
    }
    if (!stat.isFile()) {
      throw new NotFoundException('File not found');
    }

    const { contentType, inline } =
      PREVIEW_CONTENT_TYPES[extname(file).toLowerCase()] ??
      DEFAULT_PREVIEW_CONTENT_TYPE;
    return { path, contentType, inline };
  }

  /**
   * docs/PROFILE_PAGE_TABS.md T2, tab 1: the caller's uploads joined with
   * each upload's parse-job status. There is no dedicated uploads table —
   * `profile_jobs` (kind='parse') is the only durable record of an upload,
   * one row per upload, `created_at` stamped exactly at upload time.
   *
   * Known gap (flagged 2026-08-30 work log, not fixed there because it's a
   * cross-repo contract): the original client filename + sha256 are recorded
   * in the job's `result` column ONLY at creation time
   * (`ProfileService.uploadResume`) and get overwritten once the bot's drain
   * job finishes the parse and writes its real output there — there is no
   * separate durable store for upload metadata. So `filename`/`sha256` are
   * only reliably available while the job is still `pending`/`running`.
   * Once a job is `done`/`error`, `filename` is genuinely unrecoverable and
   * comes back `null`; `sha256` is recomputed from the file still on disk
   * (content-derived, so it's identical to the original) when that succeeds,
   * `null` if the file itself is gone.
   */
  listUploads(userId: string): UploadListItem[] {
    const rows = this.tracker.db
      .prepare(
        `SELECT id, payload, status, result, created_at as createdAt
         FROM profile_jobs WHERE user_id = ? AND kind = 'parse'
         ORDER BY created_at DESC, rowid DESC`,
      )
      .all(userId) as {
      id: string;
      payload: string;
      status: string;
      result: string;
      createdAt: string;
    }[];

    return rows.map((row) => {
      const meta = tryParseUploadMetadata(row.result);
      const sha256 =
        meta?.sha256 ?? this.recomputeUploadSha256(userId, row.payload);
      return {
        id: uploadIdFromPayload(row.payload),
        filename: meta?.filename ?? null,
        sha256,
        uploadedAt: row.createdAt,
        jobId: row.id,
        jobStatus: row.status,
      };
    });
  }

  private recomputeUploadSha256(
    userId: string,
    payload: string,
  ): string | null {
    try {
      // `payload` is always the server-generated `uploads/{uuid}.{ext}`
      // relative path from uploadResume() — re-derive it under uploadsDir()
      // rather than trusting the string as a free path.
      const path = safeJoin(
        this.userPaths.uploadsDir(userId),
        basename(payload),
      );
      return createHash('sha256').update(readFileSync(path)).digest('hex');
    } catch {
      return null;
    }
  }

  /**
   * docs/PROFILE_PAGE_TABS.md T2, tab 3: the rendered files in
   * users/{uid}/candidate/, whitelist-only (see profile-files.ts) — [] (not
   * an error) for a never-rendered user, matching listPreviews()'s contract.
   */
  listCandidateFiles(userId: string): CandidateFileInfo[] {
    const dir = this.userPaths.candidateDir(userId);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }

    const items: CandidateFileInfo[] = [];
    for (const name of names) {
      if (!isWhitelistedCandidateFile(name)) continue;
      const path = join(dir, name);
      let stat: Stats;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      items.push({
        name,
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
      });
    }
    // Plain codepoint order, not localeCompare — a small fixed whitelist
    // where a stable, locale-independent order matters more than "natural"
    // sorting.
    items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return items;
  }

  /**
   * Read-only by construction (bot plan decision #6: one-way DB → files —
   * there is no PUT/DELETE for these). `name` must match the whitelist
   * EXACTLY before it ever reaches the filesystem — traversal, absolute
   * paths and off-list names all fail that check first and 404, the same
   * outcome as a name that matches but doesn't exist on disk.
   */
  getCandidateFile(
    userId: string,
    name: string,
  ): { path: string; contentType: string } {
    if (!isWhitelistedCandidateFile(name)) {
      throw new NotFoundException('File not found');
    }
    const path = safeJoin(this.userPaths.candidateDir(userId), name);
    let stat: Stats;
    try {
      stat = statSync(path);
    } catch {
      throw new NotFoundException('File not found');
    }
    if (!stat.isFile()) {
      throw new NotFoundException('File not found');
    }
    return { path, contentType: candidateFileContentType(name) };
  }

  private listDirNames(dir: string): string[] {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }
    return names.filter((name) => {
      if (name.startsWith('.')) return false;
      try {
        return statSync(join(dir, name)).isDirectory();
      } catch {
        return false;
      }
    });
  }

  private listFileNames(dir: string): string[] {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }
    return names.filter((name) => {
      if (name.startsWith('.')) return false;
      try {
        return statSync(join(dir, name)).isFile();
      } catch {
        return false;
      }
    });
  }

  /**
   * Right-to-erasure (docs/RESUME_PROFILE_STORE.md): wipe every profile-store
   * row for this user across both databases. The uploads/ directory itself
   * is not removed here — it dies with the rest of users/{id}/ in
   * AdminService.deleteUser, same as candidate/ and Applications/ today.
   */
  eraseUser(userId: string): void {
    this.repo.deleteAllForUser(userId);
    this.tracker.db
      .prepare('DELETE FROM profile_jobs WHERE user_id = ?')
      .run(userId);
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
    kind: 'render' | 'parse' | 'preview',
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
