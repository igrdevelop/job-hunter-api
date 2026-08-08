import {
  BUILTIN_DEFAULTS,
  FILTER_KEY_META,
  FilterProfile,
  FilterValue,
  MAX_LIST_ENTRIES,
  MAX_PATTERN_LENGTH,
} from './filters-schema';

export type FilterOverrides = Record<string, FilterValue>;

export type ValidateResult =
  | { ok: true; value: FilterOverrides }
  | { ok: false; errors: Record<string, string> };

/** Python `(?P<name>)`, JS `(?<name>)`, inline flags `(?i)` — not portable. */
const NON_PORTABLE_RE = /\(\?P<|\(\?<[^!=]|\(\?[aiLmsux]+\)/;

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function asStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function listHas(haystack: string[], needle: string): boolean {
  const n = needle.toLowerCase();
  return haystack.some((h) => h.toLowerCase() === n);
}

function builtinStrings(key: string): string[] {
  const v = BUILTIN_DEFAULTS[key];
  return Array.isArray(v) ? v : [];
}

/**
 * Append user entries not already present (case-insensitive for strings).
 * Mirrors hunter.filter_profile._extend_list.
 */
export function extendList(base: string[], extra: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of [...base, ...extra]) {
    const marker = item.toLowerCase();
    if (seen.has(marker)) continue;
    seen.add(marker);
    out.push(item);
  }
  return out;
}

function checkPortableRegex(pat: string): string | null {
  if (pat.length > MAX_PATTERN_LENGTH) {
    return `pattern exceeds ${MAX_PATTERN_LENGTH} chars`;
  }
  if (NON_PORTABLE_RE.test(pat)) {
    return 'portable regex only';
  }
  try {
    // eslint-disable-next-line no-new
    new RegExp(pat);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `invalid regex: ${msg}`;
  }
  return null;
}

/**
 * Validate a PUT body (overrides only). Stricter than the bot loader:
 * unknown keys and bad types/regexes are hard errors (all-or-nothing).
 *
 * extend_only: additions-only lists are OK; if any builtin is present, ALL
 * builtins must be present ("cannot remove builtin entries").
 */
export function validateOverrides(raw: unknown): ValidateResult {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: { _: 'root must be a mapping' } };
  }

  const errors: Record<string, string> = {};
  const value: FilterOverrides = {};

  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    const meta = FILTER_KEY_META[key];
    if (!meta) {
      errors[key] = 'unknown key';
      continue;
    }
    if (meta.derived) {
      errors[key] = `derived from ${meta.derived} — cannot set in filters.yaml`;
      continue;
    }

    if (meta.type === 'boolean') {
      if (typeof val !== 'boolean') {
        errors[key] = 'expected boolean';
        continue;
      }
      value[key] = val;
      continue;
    }

    // string_list / pattern_list
    if (!Array.isArray(val)) {
      errors[key] = 'expected array of strings';
      continue;
    }
    if (val.length > MAX_LIST_ENTRIES) {
      errors[key] = `list exceeds ${MAX_LIST_ENTRIES} entries`;
      continue;
    }
    if (!asStringList(val)) {
      errors[key] = 'expected array of strings';
      continue;
    }

    let listOk = true;
    for (let i = 0; i < val.length; i++) {
      const item = val[i];
      if (item.trim() === '') {
        errors[`${key}[${i}]`] = 'empty string not allowed';
        listOk = false;
        continue;
      }
      if (meta.type === 'pattern_list') {
        const preg = checkPortableRegex(item);
        if (preg) {
          errors[`${key}[${i}]`] = preg;
          listOk = false;
        }
      }
    }

    if (meta.merge === 'extend_only') {
      const builtins = builtinStrings(key);
      const hasAnyBuiltin = builtins.some((b) => listHas(val, b));
      if (hasAnyBuiltin) {
        const missing = builtins.filter((b) => !listHas(val, b));
        if (missing.length) {
          errors[key] = `cannot remove builtin entries: ${missing.join(', ')}`;
          listOk = false;
        }
      }
    }

    if (listOk) {
      value[key] = val;
    }
  }

  if (Object.keys(errors).length) {
    return { ok: false, errors };
  }
  return { ok: true, value };
}

/**
 * Merge overrides onto defaults (replace / extend_only). Always re-applies
 * derived `locations` from defaults.
 */
export function mergeFilters(
  defaults: FilterProfile,
  overrides: FilterOverrides,
): FilterProfile {
  const result = deepClone(defaults);
  for (const [key, val] of Object.entries(overrides)) {
    const meta = FILTER_KEY_META[key];
    if (!meta || meta.derived) continue;
    if (meta.merge === 'replace') {
      result[key] = deepClone(val);
      continue;
    }
    if (meta.merge === 'extend_only' && Array.isArray(val)) {
      const base = Array.isArray(result[key]) ? (result[key] as string[]) : [];
      result[key] = extendList(base, val);
    }
  }
  if ('locations' in defaults) {
    result.locations = deepClone(defaults.locations);
  }
  return result;
}

/**
 * Prepare overrides for YAML write:
 * - omit replace keys equal to their default (don't pin stale copies);
 * - strip builtin entries from extend_only lists (store additions only);
 * - omit empty extend_only lists after strip.
 */
export function stripDefaultsForWrite(
  overrides: FilterOverrides,
  defaults: FilterProfile = BUILTIN_DEFAULTS,
): FilterOverrides {
  const out: FilterOverrides = {};
  for (const [key, val] of Object.entries(overrides)) {
    const meta = FILTER_KEY_META[key];
    if (!meta || meta.derived) continue;

    if (meta.merge === 'extend_only' && Array.isArray(val)) {
      const builtins = Array.isArray(defaults[key])
        ? (defaults[key] as string[])
        : [];
      const additions = val.filter((item) => !listHas(builtins, item));
      if (additions.length) {
        out[key] = additions;
      }
      continue;
    }

    if (deepEqual(val, defaults[key])) {
      continue;
    }
    out[key] = deepClone(val);
  }
  return out;
}
