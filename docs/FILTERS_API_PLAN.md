# FILTERS_API Plan — per-user job-filter endpoints

**Status:** M1–M3 done (2026-08-08)
**Date:** 2026-08-08
**Motivation:** companion to the bot repo's `docs/FILTERS_YAML_PLAN.md`
(read it first — it defines the file format, the merge model and the page
that consumes these endpoints). The bot is extracting its job-intake filter
policy from Python code into per-user `users/{uid}/candidate/filters.yaml`
files; the web app gets a settings page ("Job Filters") that edits that file
through this API. This plan covers the api repo's side: two endpoints, a
TypeScript validator, and a cross-repo contract test.

## Current state (checked 2026-08-08)

- `GET /api/filters`, `PUT /api/filters` → **404** — no module exists.
- The nearest existing pattern is `SettingsModule` (`GET/PUT /api/settings`):
  JWT-scoped via `@CurrentUser()`, per-user values in the `user_settings`
  table. Filters do NOT go into `user_settings` — the bot reads a YAML file,
  not the table, so the file IS the storage.
- **Gap worth noting:** `POST /api/files` can ALREADY upload a raw
  `filters.yaml` into `candidate/` today, with zero validation — the bot's
  loader defends itself (drops invalid regexes with a warning), but the
  structured endpoint below is what makes editing safe and diffable.
- The api container is `node:22-alpine` in a compose project SEPARATE from
  the bot's. **No Python is available** — validation must be implemented in
  TypeScript; parity with the bot's Python loader is enforced by shared
  fixtures (below), not by shelling out.

## Endpoints

Both JWT-required, user from `@CurrentUser()` (never a path param), same
email-verified gate as every other `/api/*` route.

### `GET /api/filters`

```json
{
  "defaults":  { "title_keywords": ["angular", "frontend", "front-end", "javascript", "typescript"], "...": "every key with its builtin default" },
  "overrides": { "title_keywords": ["react", "frontend"] },
  "effective": { "title_keywords": ["react", "frontend"], "...": "defaults ⊕ overrides, per merge strategy" },
  "meta": {
    "title_keywords":        { "type": "string_list", "merge": "replace" },
    "exclude_patterns":      { "type": "pattern_list", "merge": "replace" },
    "exclude_companies":     { "type": "string_list", "merge": "extend_only" },
    "extra_anti_hybrid_cities": { "type": "string_list", "merge": "extend_only" },
    "exclude_german_language_required": { "type": "boolean", "merge": "replace" },
    "...": "one meta entry per key; derived keys (locations) marked { \"derived\": \"candidate.yaml\" } and absent from overrides"
  }
}
```

- `defaults` — the builtin profile (Layer 1 in the bot plan), so the UI can
  render placeholder state and "reset to default".
- `overrides` — the parsed content of the user's `filters.yaml` (missing
  file ⇒ `{}`).
- `effective` — merged result, computed with the same merge rules the bot
  uses (replace vs extend_only per key).
- `meta` — per-key type + merge strategy so the UI knows what control to
  render and which chips are non-removable.

### `PUT /api/filters`

- Body = **overrides only** (the shape of the YAML file), never the merged
  dict. A key equal to its default must be OMITTED by the client; the server
  additionally strips key==default entries before writing so a stale copy
  never pins an old default.
- Validates (below), then writes `users/{uid}/candidate/filters.yaml`
  atomically (tmp file + rename) via `UserPathsService`. The `candidate/`
  volume is already rw-mounted.
- Success → the fresh `GET` payload. Validation failure → `400` with
  per-field errors:

```json
{ "errors": { "exclude_patterns[3]": "invalid regex: unbalanced parenthesis",
              "exclude_companies": "cannot remove builtin entries: micro1" } }
```

- All-or-nothing: a partially valid body writes NOTHING.

### `POST /api/filters/preview` — deferred to v2

"Test this vacancy against my draft filters" needs the bot's Python
`classify_job`; this container can't run it (no Python, separate compose).
Recorded options for v2: a minimal HTTP sidecar in the bot's compose, or a
shared-volume request/response file the bot polls. Do NOT reimplement the
classifier in TS — that duplicates ~300 lines of calibrated logic and will
drift.

## Validation rules (TypeScript, `filters-validator.ts`)

1. Unknown top-level key → per-field error (the bot loader only warns, but
   the API should be stricter: a typo in the UI is a bug, not user data).
2. Type check per key against the schema (`string_list` = array of
   non-empty strings; `pattern_list` = same + each entry compiles;
   `boolean`; the structured `exclude_stacks_without` object).
3. `pattern_list` entries must compile AND stick to the **portable regex
   subset** — reject Python-only `(?P<name>)` and JS-only `(?<name>)`
   named groups, backreference syntax differences, inline flags `(?i)` —
   with error "portable regex only". Cap pattern length (200 chars) and
   list sizes (200 entries) as a ReDoS/abuse guard.
4. `extend_only` keys: every builtin entry must still be present in the
   submitted value (equivalently: the stored override only ever ADDS).
5. YAML output via `js-yaml` `dump` with `schema: JSON_SCHEMA` — plain
   scalars/lists/maps only, no anchors/tags.

## Cross-repo contract (the drift guard)

`test/fixtures/filters_contract_v1.json` — committed to BOTH repos (this
one and the bot), same file byte-for-byte, versioned like the scout payload
contract (`"v": 1`). Contents:

- `valid`: complete override documents that must be accepted;
- `invalid`: documents + the expected per-field error KEY (not the message
  text — wording may differ between sides, the rejected field must not);
- `merge`: `{defaults_subset, overrides, expected_effective}` triples
  exercising replace and extend_only.

This repo's contract test runs the TS validator/merger over the fixtures;
the bot repo's runs its Python loader over the same file. A schema change
lands as `filters_contract_v2.json` in both repos in the same change window,
or a test goes red on whichever side moved alone.

## Milestones

- **M1** ✅ — `src/filters/filters-schema.ts` (key list + types + merge
  strategies + builtin defaults, transcribed from the bot's
  `hunter/filter_profile.py::builtin_defaults()` the same way
  `settings-schema.ts` transcribes `hunter/config.py`) +
  `filters-validator.ts` + `test/fixtures/filters_contract_v1.json` +
  contract unit test. No HTTP yet. NOTE: coordinate with the bot repo —
  the fixture file must land there in the same window.
- **M2** ✅ — `FiltersModule` (`filters.controller.ts`, `filters.service.ts`):
  GET (read file via UserPathsService, merge, respond) + PUT (validate,
  atomic write). e2e test with a temp USERS_ROOT: GET on missing file,
  PUT round-trip, PUT invalid → 400 + file untouched, extend_only
  violation → 400.
- **M3** ✅ — wire into `app.module.ts`, update this repo's CLAUDE.md endpoint
  table + work log.

## Risks

- **Validator drift vs the bot loader** → the shared fixture contract test
  (above) is the whole point; do not "fix" a divergence by editing only one
  side's fixture copy.
- **Concurrent writes** (user saves in two tabs) → last-write-wins is
  acceptable for a single-user file; atomic rename prevents torn files.
  The bot never writes this file — one-way ownership, no lock needed.
- **The raw files API bypass** (`POST /api/files` uploading filters.yaml
  directly) → acceptable: the bot loader is defensive (invalid regex
  dropped with a warning, unknown keys ignored). Optionally blocklist the
  filename in FilesService later; not required for v1.
- **defaults transcription staleness** (bot changes a builtin default, api
  copy lags) → the `merge` fixtures pin the defaults used in tests; a
  release-note habit + the contract version bump cover the rest. Same
  accepted trade-off as `settings-schema.ts`.
