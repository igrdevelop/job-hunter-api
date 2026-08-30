/**
 * Structural checks for PUT /api/profile — deliberately shallow. Deep
 * semantics (roles, bullets, variant precedence, ...) live in the bot's
 * hunter/profile_schema.py::validate; the API stores the document as sent
 * once these checks pass (docs/RESUME_PROFILE_STORE.md "Shared contract").
 */

export const MAX_PROFILE_BYTES = 1024 * 1024; // 1 MB
export const SUPPORTED_SCHEMA_VERSION = 1;

const VARIANT_KEY_RE = /^[a-z0-9_]+$/;
const REQUIRED_IDENTITY_FIELDS = [
  'full_name',
  'contact',
  'cv_filename_prefix',
] as const;

export type ProfileDocument = Record<string, unknown>;

export type ValidateResult =
  | { ok: true; value: ProfileDocument }
  | { ok: false; errors: Record<string, string> };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function validateProfile(raw: unknown): ValidateResult {
  if (!isPlainObject(raw)) {
    return { ok: false, errors: { _: 'root must be a mapping' } };
  }

  const errors: Record<string, string> = {};

  const size = Buffer.byteLength(JSON.stringify(raw), 'utf8');
  if (size > MAX_PROFILE_BYTES) {
    errors._ = `document exceeds ${MAX_PROFILE_BYTES} bytes`;
  }

  if (raw.schema_version !== SUPPORTED_SCHEMA_VERSION) {
    errors.schema_version = `schema_version must be ${SUPPORTED_SCHEMA_VERSION}`;
  }

  const core = isPlainObject(raw.core) ? raw.core : {};
  const identity = isPlainObject(core.identity) ? core.identity : {};
  for (const field of REQUIRED_IDENTITY_FIELDS) {
    if (asString(identity[field]).trim() === '') {
      errors[`core.identity.${field}`] = `core.identity.${field} is required`;
    }
  }

  const variants = isPlainObject(raw.variants) ? raw.variants : {};
  for (const key of Object.keys(variants)) {
    if (!VARIANT_KEY_RE.test(key)) {
      errors[`variants.${key}`] = 'invalid variant key (expected [a-z0-9_]+)';
    }
  }

  if (Object.keys(errors).length) {
    return { ok: false, errors };
  }
  return { ok: true, value: raw };
}
