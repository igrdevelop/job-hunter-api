/**
 * Filter knobs + builtin defaults, transcribed from
 * hunter/filter_profile.py::builtin_defaults() (bot commit 145b03d,
 * branch feat/filters-yaml). Same trade-off as settings-schema.ts vs
 * hunter/config.py — keep in sync when the bot changes Layer 1.
 *
 * `locations` is derived from candidate.yaml at bot load time; the static
 * default here matches the absent-candidate.yaml fallback (Wrocław aliases).
 */

export type FilterKeyType =
  | 'string_list'
  | 'pattern_list'
  | 'boolean'
  | 'derived';

export type FilterMerge = 'replace' | 'extend_only';

export type FilterValue = string[] | boolean;

export type FilterProfile = Record<string, FilterValue>;

export interface FilterKeyMeta {
  type: FilterKeyType;
  merge?: FilterMerge;
  /** Present when the key is computed outside filters.yaml. */
  derived?: string;
}

export const MAX_LIST_ENTRIES = 200;
export const MAX_PATTERN_LENGTH = 200;

/** Per-key type + merge strategy for GET /api/filters `meta`. */
export const FILTER_KEY_META: Record<string, FilterKeyMeta> = {
  title_keywords: { type: 'string_list', merge: 'replace' },
  require_angular: { type: 'boolean', merge: 'replace' },
  exclude_levels: { type: 'string_list', merge: 'replace' },
  exclude_patterns: { type: 'pattern_list', merge: 'replace' },
  exclude_react_without_angular: { type: 'boolean', merge: 'replace' },
  exclude_fullstack_with_backend: { type: 'boolean', merge: 'replace' },
  fullstack_backend_stacks: { type: 'pattern_list', merge: 'replace' },
  exclude_body_disqualifiers: { type: 'boolean', merge: 'replace' },
  body_exclude_patterns: { type: 'pattern_list', merge: 'replace' },
  exclude_body_onsite_city: { type: 'boolean', merge: 'replace' },
  allow_low_frequency_hybrid: { type: 'boolean', merge: 'replace' },
  exclude_ai_training: { type: 'boolean', merge: 'replace' },
  exclude_companies: { type: 'string_list', merge: 'extend_only' },
  exclude_german_language_required: { type: 'boolean', merge: 'replace' },
  exclude_unacceptable_contract: { type: 'boolean', merge: 'replace' },
  exclude_relocation_required: { type: 'boolean', merge: 'replace' },
  extra_anti_hybrid_cities: { type: 'string_list', merge: 'extend_only' },
  locations: { type: 'derived', derived: 'candidate.yaml' },
};

/** Editable keys (everything except derived). */
export const EDITABLE_KEYS = Object.keys(FILTER_KEY_META).filter(
  (k) => !FILTER_KEY_META[k].derived,
);

/**
 * Layer 1 defaults — verbatim from builtin_defaults() with the
 * absent-candidate.yaml locations fallback.
 */
export const BUILTIN_DEFAULTS: FilterProfile = {
  title_keywords: [
    'angular',
    'frontend',
    'front-end',
    'javascript',
    'typescript',
  ],
  require_angular: false,
  exclude_levels: [
    'junior',
    'intern',
    'internship',
    'trainee',
    'stażysta',
    'praktykant',
    'staz',
    'tech lead',
    'tech-lead',
    'techlead',
    'техлид',
    'тех-лид',
    'тех лид',
    'технический лид',
    'team lead',
    'teamlead',
    'team-lead',
    'тимлид',
    'тим-лид',
    'тим лид',
    'стажер',
    'стажёр',
    'стажиров',
    'project lead',
    'engineering manager',
    'head of engineering',
    'vp of engineering',
    'cto',
    'part-time',
    'part time',
    'parttime',
  ],
  locations: ['remote', 'zdalnie', 'zdalna', 'wrocław', 'wroclaw'],
  exclude_patterns: [
    '\\bjava\\b',
    '\\.net',
    '\\bc#',
    '\\bphp\\b',
    '\\bqa\\b',
    '\\bsdet\\b',
    'quality\\s+assurance',
    'test\\s+automation',
    '\\bbackend\\b',
    '\\bback-end\\b',
    '\\bvue\\b',
    '\\bnuxt\\b',
    '\\bmagento\\b',
    '\\bruby\\b',
    '\\breact\\s+native\\b',
    '\\breact[- ]native\\b',
    '\\bhyv[äa]\\b',
    '\\badobe\\s+commerce\\b',
    '\\bpwa\\s+studio\\b',
    '\\bshopware\\b',
    '\\bshopify\\b',
    '\\bbigcommerce\\b',
    '\\bwoocommerce\\b',
    '\\bdrupal\\b',
    '\\bwordpress\\b',
    '\\bsharepoint\\b',
    '\\bsap\\b',
    '\\bsalesforce\\b',
    '\\bdevops\\b',
    '\\bdev-ops\\b',
    '\\bsre\\b',
    '\\bplatform\\s+engineer\\b',
    '\\bcloud\\s+engineer\\b',
    '\\binfrastructure\\s+engineer\\b',
    '\\bandroid\\b',
    '\\bios\\s+developer\\b',
    '\\bswift\\s+developer\\b',
    '\\bkotlin\\s+developer\\b',
    '\\bflutter\\b',
    '\\bautomation\\s+engineer\\b',
    '\\btesting\\s+engineer\\b',
    '\\btech\\s+lead\\b',
    '\\bproject\\s+lead\\b',
    '\\bpart[- ]?time\\b',
    '\\bmendix\\b',
    '\\boutsystems\\b',
    '\\blow[-\\s]?code\\b',
    '\\bemail\\s+developer\\b',
    '\\bui\\s+designer\\b',
    '\\bai\\s+train(?:ing|er)\\b',
    '\\bai\\s+tutor\\b',
    '\\bdata\\s+annotat\\w*\\b',
    '\\bdata\\s+label(?:l)?ing\\b',
  ],
  exclude_react_without_angular: true,
  exclude_fullstack_with_backend: true,
  fullstack_backend_stacks: [
    '\\bjava\\b',
    '\\bspring(?:\\s+boot)?\\b',
    '\\.net\\b',
    '\\basp\\.net\\b',
    '\\bc#',
    '\\bpython\\b',
    '\\bdjango\\b',
    '\\bgolang\\b',
    '\\bphp\\b',
    '\\bruby\\s+on\\s+rails\\b',
  ],
  exclude_body_disqualifiers: true,
  body_exclude_patterns: [
    '\\bblazor\\b',
    '\\bmendix\\b',
    '\\boutsystems\\b',
    '\\blow[-\\s]?code\\b',
    '\\bwordpress\\b',
    '\\bdrupal\\b',
    '\\bmagento\\b',
    '\\bsharepoint\\b',
  ],
  exclude_body_onsite_city: true,
  allow_low_frequency_hybrid: true,
  exclude_ai_training: true,
  exclude_companies: [
    'micro1',
    'alignerr',
    'quikhire',
    'hirefeed',
    'mercor',
    'outlier ai',
  ],
  exclude_german_language_required: true,
  exclude_unacceptable_contract: true,
  exclude_relocation_required: true,
  extra_anti_hybrid_cities: [
    'helsinki',
    'helsingfors',
    'barcelona',
    'madrid',
    'lisbon',
    'lisboa',
    'berlin',
    'munich',
    'münchen',
    'hamburg',
    'frankfurt',
    'amsterdam',
    'rotterdam',
    'prague',
    'brno',
    'bratislava',
    'budapest',
    'bucharest',
    'sofia',
    'zagreb',
    'limassol',
    'nicosia',
    'larnaca',
    'larnaka',
    'paphos',
    'pafos',
    'islamabad',
    'karachi',
    'lahore',
    'bangalore',
    'mumbai',
    'delhi',
    'singapore',
    'dubai',
    'abu dhabi',
    'hong kong',
    'tokyo',
  ],
};

/** GET meta payload: type + merge, or derived marker. */
export function buildFiltersMeta(): Record<
  string,
  { type: string; merge?: string; derived?: string }
> {
  const meta: Record<string, { type: string; merge?: string; derived?: string }> =
    {};
  for (const [key, def] of Object.entries(FILTER_KEY_META)) {
    if (def.derived) {
      meta[key] = { type: def.type, derived: def.derived };
    } else {
      meta[key] = { type: def.type, merge: def.merge };
    }
  }
  return meta;
}
