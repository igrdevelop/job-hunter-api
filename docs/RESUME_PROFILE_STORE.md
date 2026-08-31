# Resume Profile Store — api repo work order

Companion of the bot repo's `docs/RESUME_PROFILE_STORE_PLAN.md` (the argument +
M0 measurements) and `docs/RESUME_PROFILE_STORE_PROMPT.md` (the bot-side
executor steps). A third companion exists in `job-hunter-site`
(`docs/RESUME_PROFILE_STORE.md`). **The "Shared contract" section below is
duplicated in the site work order and must stay in sync with the bot plan. Do
not change contract details unilaterally — flag mismatches to the user.**

## Goal

Users upload their existing resume on the site, see everything the parser
extracted as editable fields, extend it (skills, roles, anything), and the
system renders the profile into the three files the Python pipeline already
consumes (`candidate.yaml`, `candidate_profile.md`, `base_cv_<track>.md`).
This repo owns: canonical storage, the REST surface, upload intake, and the
job handoff to the bot. The bot owns: schema semantics, the parser, the
renderer (all landed/landing per its own work order). The site owns the editor
UI.

Bot-side prerequisites (check before starting each phase): `hunter/
profile_schema.py` + `candidate/profile.example.json` (bot PR #238, merged),
renderer (bot steps 2a–2c), parser (3a–3c), and the queue drain (bot step 4c —
**not yet in the bot work order; a follow-up PR there adds it**; this doc is
the contract source for it until then).

## Shared contract

### Document

- Canonical shape = the bot's `hunter/profile_schema.py` (`schema_version: 1`).
  Normative example: bot repo `candidate/profile.example.json`. A byte-copy of
  it lives here as `test/fixtures/profile_contract_v1.json` (same discipline
  as `filters_contract_v1.json`) — a contract unit test loads it and asserts
  the API's TS-side structural checks accept it unchanged. Schema drift then
  fails loudly in whichever repo diverged.
- `core` holds facts once; `variants` hold per-track presentation deltas;
  per-element `origin: "parsed" | "edited"`; role-level `*_by_track`
  overrides. The API treats the document as opaque beyond the structural
  checks below — **merge logic (parsed draft vs user edits) is a UI concern;
  the server stores what the client sends and keeps revisions as the safety
  net.**

### Storage split

- **app.sqlite (this repo owns, versioned migration):**

  ```sql
  -- migration 003
  CREATE TABLE IF NOT EXISTS profiles (
    user_id        TEXT PRIMARY KEY,
    json           TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    revision       INTEGER NOT NULL DEFAULT 1,
    updated_at     TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS profile_revisions (
    user_id    TEXT NOT NULL,
    rev        INTEGER NOT NULL,
    json       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, rev)
  );
  -- keep the last 20 revisions per user (prune on insert)
  ```

- **tracker.db (shared bus; this repo owns the schema, bot mirrors it
  idempotently in `hunter/db.py` — same rule as MULTI_USER_UPDATE.md):**

  ```sql
  CREATE TABLE IF NOT EXISTS profile_jobs (
    id         TEXT PRIMARY KEY,             -- uuid
    user_id    TEXT NOT NULL,
    kind       TEXT NOT NULL,                -- 'render' | 'parse' | 'preview'
                                             --   ('preview' added later — see
                                             --    docs/PROFILE_PAGE_TABS.md)
    payload    TEXT NOT NULL DEFAULT '',     -- see below
    status     TEXT NOT NULL DEFAULT 'pending', -- pending|running|done|error
    result     TEXT NOT NULL DEFAULT '',
    error      TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_profile_jobs_status
    ON profile_jobs(status, created_at);
  ```

  - `kind='render'`: `payload` = the FULL profile JSON (self-contained — the
    bot never reads app.sqlite). The bot's drain job runs
    `hunter.profile_render.render_all()` into `users/{uid}/candidate/` and
    writes the written-file list into `result`.
  - `kind='parse'`: `payload` = path of the uploaded file RELATIVE to
    `users/{uid}/` (e.g. `uploads/3f2a… .docx`; both containers mount the same
    `USERS_ROOT`). The bot runs extract+parse and writes the draft profile
    JSON (with `leftovers`) into `result`.
  - Precedent for the bus: `telegram_link_codes` (API writes, bot consumes).
    Drain cadence bot-side: a JobQueue task every ~20 s (same pattern as
    `scheduled_reset_stale_claims`). A `running` job older than 10 min is
    re-marked `pending` by the bot (crash recovery); an `error` job is
    terminal — the client sees `error` and may retry by re-submitting.
  - Why not HTTP: the SAAS-plan Stage 1 Python service does not exist yet;
    when it lands, `render`/`parse` become endpoints there and this table
    retires. The REST surface below does not change.

### REST surface (all JWT, user-scoped; rate limits noted)

```
GET  /api/profile                  → 200 { profile, revision, updatedAt }
                                     404 when the user has no profile yet
PUT  /api/profile                  body = full document
                                   → 200 { revision, renderJobId }
                                     400 { errors: [...] } on structural failure
POST /api/profile/uploads          multipart file (docx|pdf|txt|md, ≤ 10 MB)
                                   → 201 { jobId }        (throttle: 10/hour)
GET  /api/profile/jobs/:id         → { kind, status, result?, error? }  (poll)
GET  /api/profile/revisions        → [ { rev, createdAt } ]
POST /api/profile/revisions/:rev/restore → same response as PUT
```

Server-side checks on PUT (deliberately shallow — deep semantics live in the
bot's `profile_schema.validate`): body ≤ 1 MB, `schema_version === 1`,
`core.identity.full_name/contact/cv_filename_prefix` non-empty (mirrors
`REQUIRED_IDENTITY_FIELDS` — a document failing this cannot render a working
`candidate.yaml`), `variants` keys are `[a-z0-9_]+`. Everything else is
stored as sent.

### Flows

```
Save:    site PUT /api/profile → validate → profiles upsert (rev++)
         → profile_revisions insert (+prune >20) → profile_jobs(kind=render,
         payload=json) → 200. Bot drains ≤ ~20 s later → files under
         users/{uid}/candidate/ → next hunt/apply sees the new profile.

Upload:  site POST /api/profile/uploads → file saved to
         users/{uid}/uploads/{uuid}{ext} → profile_jobs(kind=parse,
         payload=relpath) → { jobId } → site polls GET jobs/:id → status=done
         → result = draft profile JSON + leftovers → site shows the
         confirmation screen → user merges → PUT /api/profile (normal save).
```

### Erasure & ownership

Right-to-erasure is one operation: delete `profiles` + `profile_revisions` +
`profile_uploads` rows (app.sqlite), the user's `profile_jobs` rows
(tracker.db), and `users/{uid}/uploads/` — wire it into the existing admin
`DELETE /api/admin/users/:id` path (which already owns per-user file cleanup
semantics). Rendered `candidate/` files die with the user directory as today.

## Phases (one PR each)

### P1 — Migration + ProfileModule core (GET/PUT, revisions, no queue yet)

- `src/db/migrations.ts`: migration 003 (DDL above, app.sqlite only).
- `ProfileModule` (`profile.controller.ts`, `profile.service.ts`,
  `profile-validate.ts`): GET (404 on absent), PUT (checks above; upsert +
  revision + prune; `renderJobId: null` for now), revisions list + restore.
  Model FiltersModule — it is the closest existing shape (per-user resource,
  validation, contract fixture).
- `test/fixtures/profile_contract_v1.json` — byte-copy of the bot's
  `candidate/profile.example.json` @ its merged commit; contract unit test:
  fixture passes PUT validation; a fixture stripped of `full_name` fails
  with the right error string.
- e2e (temp `APP_DB_PATH` + `USERS_ROOT`, like filters e2e): PUT→GET
  round-trip byte-equal; revision increments; restore works; prune at 20;
  **isolation: user A's token on user B's profile returns A's own data /
  404, never B's** (SAAS risk #1 — tests, not discipline).

### P2 — Render handoff (profile_jobs)

- `tracker-migrations.ts`: `profile_jobs` DDL (idempotent, same style as the
  MULTI_USER tables).
- PUT now inserts a `render` job (uuid, payload=json) inside the same
  better-sqlite3 transaction boundary style used elsewhere; returns its id.
  `busy_timeout` pragma is already set on tracker.db connections — keep it.
- `GET /api/profile/jobs/:id` (scoped: job.user_id must match caller).
- e2e: PUT creates a pending row with self-contained payload; job endpoint
  404s across users.
- **Deploy note:** harmless to ship before the bot's drain exists — jobs sit
  `pending`; the site copy says "applies within a minute" only after the bot
  side is live.

### P3 — Upload intake + parse handoff

- `POST /api/profile/uploads`: multipart (reuse FilesModule's upload
  plumbing/limits), extension whitelist `docx|pdf|txt|md`, ≤ 10 MB, stored as
  `users/{uid}/uploads/{uuid}.{ext}` (original filename + sha256 recorded in
  app.sqlite's `profile_uploads` table, migration 004 — never trusted for the
  path; the job row's `result` stays empty, it belongs to the bot's parse
  output), `parse` job inserted. Throttled 10/hour/user (`@nestjs/throttler`
  like /auth).
- e2e: bad extension 400; oversize 413/400; path traversal in filename is
  inert; job row's payload is relative and inside the user's directory.

### P4 — Erasure + admin

- Extend admin user deletion with the erasure list above; e2e proves a
  deleted user leaves no profile rows, no jobs, no uploads directory.

### P5 — Owner seeding (ops, no code)

One-time: PUT the owner's real profile document (built during bot M0b) with
the owner's JWT once the bot renderer (2a–2c) + drain (4c) are deployed;
verify the rendered `users/{ownerId}/candidate/*` files are byte-equivalent
to the hand-written ones (the bot M0b round-trip already proved the transform;
this verifies the deployed loop). Until then the owner's hand-written files
keep working — render output is indistinguishable to the pipeline.

## Risks / decisions

- **Tenant isolation** — every phase lands with cross-user e2e; no endpoint
  reads a path not derived from `UserPathsService`.
- **Two DBs, no distributed transaction** — mitigated by making the job
  payload self-contained (a lost job re-renders on next PUT; rendering is
  idempotent full-overwrite) and revisions covering the document itself.
- **Concurrent PUTs** — last-write-wins is acceptable for a single-person
  profile; revisions are the undo. A `If-Match: revision` header is a cheap
  later hardening, not v1.
- **The parser is bot-side on purpose** — LLM keys and `hunter/` code live
  only there; this repo never calls an LLM.
- **`REGISTRATION_ENABLED=false`** in prod today ⇒ effective rollout is
  owner-first; nothing here assumes multi-tenant traffic beyond the tests.

## Coordination

- Bot follow-up PR needed (step "4c" in its work order): mirror
  `profile_jobs` DDL in `hunter/db.py` + a drain schedule
  (`hunter/schedules/profile_jobs.py`, ~every 20 s / next JobQueue tick)
  calling `profile_render.render_all` / `profile_parse.parse_resume_file`.
  Until it deploys, P2/P3 jobs stay `pending` — by design.
- The site work order (`job-hunter-site/docs/RESUME_PROFILE_STORE.md`)
  consumes this REST surface; its F1–F2 run against a mock of
  `profile_contract_v1.json` and do not block on any phase here.
- Update `CLAUDE.md` (endpoints table, DDL notes, work log) in the same PR as
  each phase.
