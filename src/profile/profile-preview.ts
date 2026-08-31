/**
 * docs/PROFILE_PAGE_TABS.md T1 — preview job flow helpers.
 *
 * Path-safety note: `track` doubles as a job-queue value (mirrored verbatim
 * into the profile_jobs payload the bot uses as a filesystem path component)
 * AND, for the two read endpoints, an actual URL path segment. Both callers
 * share this one slug check so a value that clears validation here is safe
 * on both sides of the bus, matching the bot's own `_resolve_user_relative_path`
 * discipline described in the work order.
 */

// `^[a-z][a-z0-9_]*$` already accepts the literal "core" — it is not a
// separate exception, just the common case of a one-word slug.
const TRACK_RE = /^[a-z][a-z0-9_]*$/;

export function isValidTrack(value: unknown): value is string {
  return typeof value === 'string' && TRACK_RE.test(value);
}

/**
 * `:ts` and `:file` route params: reject anything that could reshape the
 * joined path — a literal `/` or `\` (Express decodes a URL-encoded `%2F`
 * before the param reaches us, so this is not redundant with routing),
 * `..`, or an empty string. `safeJoin` (src/files/safe-path.ts) re-checks
 * the same class of thing on the resolved path as a second line of defense.
 */
export function isPathSafeComponent(value: string): boolean {
  if (!value) return false;
  if (value.includes('/') || value.includes('\\') || value.includes('..')) {
    return false;
  }
  return true;
}

export interface PreviewListItem {
  track: string;
  timestamp: string;
  files: string[];
}

export const PREVIEW_CONTENT_TYPES: Record<
  string,
  { contentType: string; inline: boolean }
> = {
  '.pdf': { contentType: 'application/pdf', inline: true },
  '.docx': {
    contentType:
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    inline: false,
  },
  '.txt': { contentType: 'text/plain; charset=utf-8', inline: true },
  '.json': { contentType: 'application/json', inline: true },
};

export const DEFAULT_PREVIEW_CONTENT_TYPE = {
  contentType: 'application/octet-stream',
  inline: false,
};
