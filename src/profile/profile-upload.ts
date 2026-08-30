import { extname } from 'path';

// docs/RESUME_PROFILE_STORE.md P3: extension whitelist for resume uploads.
export const ALLOWED_UPLOAD_EXTENSIONS = new Set(['docx', 'pdf', 'txt', 'md']);
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

/** Lowercase extension (no dot) from a filename, or '' if it has none. */
export function extensionOf(filename: string): string {
  return extname(filename).toLowerCase().replace(/^\./, '');
}
