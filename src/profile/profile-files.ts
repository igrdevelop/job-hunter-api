/**
 * docs/PROFILE_PAGE_TABS.md T2 — rendered-files tab helpers.
 *
 * The bot renders a fixed, known set of files into `users/{uid}/candidate/`
 * (docs/RESUME_PROFILE_STORE.md's renderer step) and this endpoint is
 * read-only by construction (bot plan decision #6: one-way DB → files) —
 * so unlike FilesModule's free-path browsing, a filename here must match an
 * exact whitelist entry before it ever reaches the filesystem. There is no
 * PUT/DELETE for these paths.
 */

const STATIC_WHITELIST = new Set([
  'candidate.yaml',
  'candidate_profile.md',
  'generation_rules.local.md',
  'profile.json',
]);

// `base_cv_<slug>.md`, slug matching the same track-slug shape used
// elsewhere in this module (docs/PROFILE_PAGE_TABS.md T1's TRACK_RE).
const BASE_CV_RE = /^base_cv_[a-z][a-z0-9_]*\.md$/;

export function isWhitelistedCandidateFile(name: string): boolean {
  return STATIC_WHITELIST.has(name) || BASE_CV_RE.test(name);
}

export const CANDIDATE_FILE_CONTENT_TYPES: Record<string, string> = {
  'candidate.yaml': 'text/yaml; charset=utf-8',
  'candidate_profile.md': 'text/markdown; charset=utf-8',
  'generation_rules.local.md': 'text/markdown; charset=utf-8',
  'profile.json': 'application/json',
};

export function candidateFileContentType(name: string): string {
  if (CANDIDATE_FILE_CONTENT_TYPES[name]) {
    return CANDIDATE_FILE_CONTENT_TYPES[name];
  }
  if (BASE_CV_RE.test(name)) {
    return 'text/markdown; charset=utf-8';
  }
  return 'application/octet-stream';
}

export interface CandidateFileInfo {
  name: string;
  size: number;
  modifiedAt: string;
}

export interface UploadListItem {
  id: string;
  filename: string | null;
  sha256: string | null;
  uploadedAt: string;
  jobId: string;
  jobStatus: string;
}

export interface UploadMetadata {
  filename: string;
  sha256: string;
}

/**
 * `profile_jobs.result` holds the upload's `{filename, sha256}` metadata
 * only until the bot's drain job finishes the parse and overwrites it with
 * the real parse output (docs/PROFILE_PAGE_TABS.md T2's known gap, flagged
 * in the 2026-08-30 work log entry) — so this only succeeds while the job is
 * still pending/running. Anything that doesn't parse as that exact shape is
 * treated as "metadata no longer available", not an error.
 */
export function tryParseUploadMetadata(result: string): UploadMetadata | null {
  if (!result) return null;
  try {
    const parsed: unknown = JSON.parse(result);
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as Record<string, unknown>).filename === 'string' &&
      typeof (parsed as Record<string, unknown>).sha256 === 'string'
    ) {
      return parsed as UploadMetadata;
    }
  } catch {
    // Not JSON, or not the upload-metadata shape — fall through to null.
  }
  return null;
}

/** Extract the stored upload id (uuid) from a `parse` job's `uploads/{id}.{ext}` payload. */
export function uploadIdFromPayload(payload: string): string {
  const base = payload.split('/').pop() ?? payload;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}
