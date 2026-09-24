# CLAUDE.md — Project Context for AI Agents

Single source of truth for any agent working on this repo. Read it fully before making
changes. Update it when something here changes.

---

## What This Is

**job-hunter-api** — NestJS backend for the Job Hunter web application.
Serves only `/api/*`, `/auth/*`, and `/health` — the Angular frontend
(`job-hunter-site`) is a separate container with its own image and CI
pipeline, path-routed to the same hostname by Cloudflare Tunnel.
Reads the Python bot's `tracker.db` and serves files from `Applications/`.

- **Owner:** Ihar Petrasheuski — Senior Frontend Developer (Angular, 10+ yrs), Wrocław, PL.
  Learning NestJS with this project.
- **Live URL:** https://job-hunter.igrflex.work
- **Current state:** Deployed at job-hunter.igrflex.work. API mounts the
  bot's live `tracker.db` + `Applications/` from `/home/deploy/job-hunter/`
  (separate compose project on the same VPS). A0-A4 features live.

---

## Architecture

```
Cloudflare Tunnel (job-hunter.igrflex.work, path routing)
├── /api/*, /auth/* → job-hunter-api container, NestJS :3000
│     ├── /auth/*          → AuthModule (register, login, JWT)
│     ├── /api/applications/* → ApplicationsModule (tracker.db CRUD)
│     ├── /api/files/*     → FilesModule (browse/upload candidate/)
│     ├── /api/generated/* → GeneratedModule (Applications/ date/company tree)
│     ├── /api/templates/* → TemplatesModule (stored under candidate/templates/)
│     ├── /api/analytics/* → AnalyticsModule (funnel, cost, stats)
│     ├── /api/pipeline/*  → PipelineModule (read-only pipeline snapshot, tracker.db)
│     ├── /api/settings    → SettingsModule (read-only bot .env, secrets masked)
│     ├── /api/filters     → FiltersModule (per-user candidate/filters.yaml)
│     ├── /api/profile     → ProfileModule (structured resume profile, app.sqlite)
│     └── /health          → Health check
└── everything else → job-hunter-frontend container (nginx, job-hunter-site repo)
```

This repo builds/deploys only the NestJS container. The Angular SPA is a
separate image built and deployed by `job-hunter-site`'s own CI — see
`docker-compose.prod.yml` here, which is the single source of truth for both
services on the VPS (this repo's `deploy.yml` is the only workflow that
writes it; `job-hunter-site`'s just pulls+restarts its own `frontend`
service against it).

**Two SQLite databases:**
- `app.sqlite` — own DB, `users` table plus `profiles`/`profile_revisions`
  (docs/RESUME_PROFILE_STORE.md — the structured resume profile document +
  its revision history) and `profile_uploads` (durable upload metadata:
  original filename/sha256/stored_path per resume upload, written at POST
  time, never touched by the bot). NestJS owns schema for both.
- `tracker.db` — bot's DB, mounted via Docker volume. Bot owns schema.
  PipelineModule opens its own `readonly` handle on it and never writes or
  migrates (every other module goes through TrackerService's read-write one);
  NestJS reads freely + writes Sent/To Learn/Re-application (mirrored to the
  Sheet) plus the API-owned `app_status`/`owner_reason`/`owner_reason_note`
  columns (never mirrored) and, as of 2026-09-14, the bot-owned
  `outcome_label`/`outcome_at` pair (set-only,
  same dirty rule as a mirrored column — see the Agent Work Log entry below
  and `src/tracker/app-status.ts`). Also has `profile_jobs` (render/parse
  handoff, API writes/bot drains — same precedent as `telegram_link_codes`;
  the bot's own drain job is a follow-up in its repo, see
  docs/RESUME_PROFILE_STORE.md P2 coordination note).

**Shared Docker volumes with Python bot:**
- `tracker.db` — read-write (bot writes applications, NestJS writes
  Sent/To Learn/Re-application (mirrored to the Sheet), the api-owned
  app_status/owner_reason/owner_reason_note (never mirrored), and the
  bot-owned outcome_label/outcome_at pair — set-only, see above)
- `Applications/` — read-only (bot writes generated CVs, NestJS serves via `/api/generated`)
- `candidate/` — read-write (bot personal assets; NestJS serves/uploads via `/api/files` + templates)
- `.env` — read-only (bot config; NestJS serves masked via `/api/settings`, `BOT_ENV_PATH`)

---

## Tech Stack

- **NestJS** (latest)
- **better-sqlite3** — direct SQLite access (no ORM overhead for reading bot's DB)
- **Passport + JWT** — authentication
- **class-validator** — DTO validation
- Node 22+

---

## Commands

| Command | What it does |
|---|---|
| `npm run start:dev` | Dev server at http://localhost:3000 (hot reload) |
| `npm run build` | Production build → `dist/` |
| `npm run start:prod` | Run production build |
| `npm test` | Unit tests |
| `npm run test:e2e` | E2E tests |

---

## Deployment

Docker container on the VPS (178.105.131.107), exposed via Cloudflare Tunnel
as `job-hunter.igrflex.work` (path-routed: `/api`, `/auth` here, everything
else to the `job-hunter-frontend` container). Standalone `docker-compose`
project at `/home/deploy/job-hunter-web/` on the VPS — separate from the
bot's own compose stack (different repo, different lifecycle, only shares
the host).

The Dockerfile is a plain 2-stage Node build: install/compile → slim
`node:22-alpine` runtime running `dist/main.js`. No frontend build step —
`job-hunter-site` builds and pushes its own image independently.

`.github/workflows/deploy.yml` builds+pushes `ghcr.io/igrdevelop/job-hunter-api`,
then SSHes to the VPS and writes `docker-compose.prod.yml` (backing up the
previous version to `.bak` first) and `.env` from GitHub secrets, covering
both the `job-hunter-api` and `frontend` service definitions — this repo is
the sole owner/writer of that compose file. Its `test` job (runs on every PR
and gates the deploy job) runs unit tests (`npm test`), e2e tests
(`npm run test:e2e`) and `npm run build`; lint is not a CI gate.

---

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `JWT_SECRET` | yes | Secret for JWT signing (64+ chars) |
| `APP_DB_PATH` | no | Path to app.sqlite (default: `./data/app.sqlite`) |
| `TRACKER_DB_PATH` | no | Path to bot's tracker.db (default: `./data/tracker.db`) |
| `USERS_ROOT` | no | Per-user storage root (default: `./data/users`) |
| `BOT_ENV_PATH` | no | Path to bot `.env` for read-only Settings page (default: `./data/.env`) |
| `REGISTRATION_ENABLED` | no | Allow public registration (default: `false`) |
| `SMTP_HOST` | no | SMTP host for email verification (unset = log links to console) |
| `SMTP_PORT` | no | SMTP port (default: `587`) |
| `SMTP_USER` | no | SMTP auth user |
| `SMTP_PASS` | no | SMTP auth password |
| `SMTP_FROM` | no | From address for emails |
| `APP_BASE_URL` | no | Base URL for email links (default: `https://job-hunter.igrflex.work`) |
| `SEED_USER_EMAIL` | no | Owner email, seeded on first start |
| `SEED_USER_PASSWORD` | no | Owner password, seeded on first start |
| `APPLY_FAILURES_LOG_PATH` | no | The bot's `logs/apply_failures.jsonl`, read by `GET /api/pipeline/snapshot` for `apply.failures.log_records`. Unset (default) → that key is `null`, a valid contract value. Prod leaves it unset: `docker-compose.prod.yml` mounts the bot's `db/`, `users/` and `.env` but not its `logs/`. |
| `OWNER_USER_ID` | no | Optional NARROWING override for `isOwner` on `GET /auth/me` (docs/PROFILE_PAGE_TABS.md T3, revised 2026-09-01). Normally `isOwner` derives from `role='admin'` with zero config — the original env-only mechanism was wiped on every deploy (the workflow rewrites `.env` on the VPS; live incident 2026-09-01). Set only in a multi-admin deployment where exactly one admin is "the owner"; when set, it alone decides ownership. |

---

## API endpoints

```
# Auth (public, rate-limited: 30/min per client IP — CF-Connecting-IP, else req.ip)
POST /auth/register        { email, password } → { id, email }   (gated by REGISTRATION_ENABLED)
POST /auth/login           { email, password } → { accessToken }
POST /auth/verify          { token }           → { ok: true }   (400 non-string/empty token, 403 unknown/expired)
POST /auth/resend          { email }           → { ok: true }   (400 malformed email; a well-formed unknown
                                                                  email still gets { ok: true } — no existence leak)

# Auth (JWT required)
GET  /auth/me              → { id, email, role, emailVerified, isOwner }  (docs/PROFILE_PAGE_TABS.md
                              T3 (revised 2026-09-01): isOwner = role==='admin' when OWNER_USER_ID is
                              unset; when set, id===OWNER_USER_ID alone decides — gates owner-only site UI)
GET  /auth/download-token  → { token }  (5-min aud='download' JWT for window.open — accepted ONLY
                              as ?dt= on DownloadAuthGuard file routes; as `Authorization: Bearer`
                              it is rejected with 401 everywhere, incl. the file routes)

# Every token (bearer or ?dt=) is re-checked against app.sqlite on each request: a deleted or
# disabled account → 401 even while the token is unexpired, and role/email come from the users
# row, never from the token's claims. Non-admin unverified accounts → 403 on /api/* AND on the
# DownloadAuthGuard file routes (shared helper: src/auth/authenticated-user.ts).

# Applications (JWT required, user-scoped)
GET    /api/applications        ?page=&limit=&sort=&order=&status=&search=
GET    /api/applications/stats  → { total, unsent, filled }
GET    /api/applications/funnel ?days=30
GET    /api/applications/:id
PATCH  /api/applications/:id    { sent?, toLearn?, reapplication?, appStatus?,
                                   ownerReason?, ownerReasonNote? }
                                 (appStatus derives sent/outcome_label/outcome_at when
                                  sent is absent from the body — see 2026-09-14 work log
                                  entries and src/tracker/app-status.ts for the mapping.
                                  appStatus:'' (Clear) on a row that WAS Skipped/Filter
                                  miss also undoes a dash `sent` marker, but ONLY when
                                  `ats_status` shows the bot didn't stamp that dash itself
                                  (BOT_DASH_ATS_STATUSES = SKIP/FAIL in app-status.ts — the
                                  bot writes its own '—' at INSERT time, before appStatus is
                                  ever touched, so `previousStatus` alone can't tell a
                                  bot-stamped dash apart from one this api derived); never a
                                  real date, and never outcome_label/outcome_at (clearing an
                                  outcome stays Telegram `/outcome <id> clear`).
                                  ownerReason/ownerReasonNote are the Skipped/Filter-miss
                                  decline-reason fields — non-empty ownerReason must be a
                                  known code allowed for the resulting appStatus or 400; a
                                  non-empty ownerReasonNote together with an explicit
                                  ownerReason:'' in the same body is also a 400 (self-
                                  contradictory); moving appStatus off Skipped/Filter miss
                                  clears both; staying on Skipped/Filter miss while the
                                  body omits ownerReason re-checks the STORED reason
                                  against the resulting status and clears just the reason
                                  (keeping the note) if a status change left it invalid.
                                  Whole PATCH runs in one `db.transaction(...).immediate()`
                                  — IMMEDIATE, not the driver's default DEFERRED, so a
                                  concurrent bot write can't produce SQLITE_BUSY_SNAPSHOT
                                  on the lock upgrade between this handler's own read and
                                  write (busy_timeout does not retry that error class); see
                                  the 2026-09-14 work log entry)

# Candidate files (JWT or ?dt= download token) — browse/upload users/{id}/candidate/
GET  /api/files                       → list root
GET  /api/files/{*path}               → list subdir or stream file
POST /api/files                       → upload to root (?path= optional)
POST /api/files/{*path}               → upload into sub-path

# Generated applications (JWT or ?dt=) — browse users/{id}/Applications/
GET /api/generated                    → date folders
GET /api/generated/:date              → company folders
GET /api/generated/:date/:company     → file list
GET /api/generated/:date/:company/:file → download/stream a file

# Templates (JWT or ?dt=) — users/{id}/templates/
GET    /api/templates                 → list all (?category= filter)
GET    /api/templates/:id/content     → download a template file
POST   /api/templates                 → upload (multipart: file + name + category + description)
DELETE /api/templates/:id             → remove a template

# Analytics (JWT required, user-scoped)
GET /api/analytics/funnel?days=30
GET /api/analytics/sources?days=30
GET /api/analytics/cost?days=30
GET /api/analytics/timeline?days=90

# Pipeline (JWT required) — docs/PIPELINE_VIZ_PLAN.md M2, read-only over tracker.db
GET /api/pipeline/snapshot?days=1   → hunt / apply / result tiers + events footer
                                      (days: integer 1..30, default 1 — N Europe/Warsaw
                                      calendar days ending today; anything else 400).
                                      Contract: the BOT repo's docs/PIPELINE_SNAPSHOT_CONTRACT.md
                                      (the bot owns it); src/pipeline/pipeline-snapshot.ts is a
                                      port of its reference tools/pipeline_snapshot.py, minus the
                                      contract's "Not in the contract" keys (next_slot, coverage,
                                      local-config keys, `at` display strings, events[].payload);
                                      run.last_event / run.refine_progress carry a raw `ts` instead;
                                      events[].details = the parsed FULL payload (stable keys only).
                                      Scoping: the hunt tier (hunt_runs/source_runs/postings_seen)
                                      is GLOBAL by design; applications/generation_runs rows and
                                      the events footer are the caller's own. No owner-only gate.
                                      A missing optional table/column → that block null (never a
                                      500); no applications table / tracker.db unreadable → 503.
                                      Contract fixtures: test/fixtures/pipeline_snapshot/.

# Settings (JWT required)
GET /api/settings          → { key: value, ... }  (per-user whitelisted keys)
PUT /api/settings          { key: value, ... }     (upsert user_settings)
GET /api/settings/global   → { categories: [...] } (admin only, masked bot .env)

# Filters (JWT required) — users/{id}/candidate/filters.yaml
GET /api/filters           → { defaults, overrides, effective, meta }
PUT /api/filters           body=overrides only → fresh GET payload (400 + per-field errors)

# Profile (JWT required) — structured resume profile, app.sqlite (profiles/profile_revisions/profile_uploads)
GET  /api/profile                        → { profile, revision, updatedAt, lastRenderJob }  (404 if none
                                            yet; lastRenderJob = { id, status, updatedAt } | null — the
                                            caller's most recent kind='render' profile_jobs row, docs/
                                            PROFILE_PAGE_TABS.md T2 — the site diffs this against the
                                            profile's own updatedAt to show "changed since last render")
PUT  /api/profile                        body=full document → { revision, renderJobId }
                                            (inserts a profile_jobs 'render' row in tracker.db;
                                             stays 'pending' until the bot's drain job lands)
GET  /api/profile/revisions              → [ { rev, createdAt } ]  (newest first, last 20 kept)
POST /api/profile/revisions/:rev/restore → same response as PUT
GET  /api/profile/jobs/:id               → { kind, status, result?, error? }  (poll; 404 across users)
POST /api/profile/uploads                multipart file (docx|pdf|txt|md, ≤10MB) → 201 { jobId }
                                            (throttled 10/hour/user; stored as users/{id}/uploads/{uuid}.ext,
                                             original filename/sha256/stored_path recorded in app.sqlite's
                                             profile_uploads at POST time — the job row's `result` stays
                                             empty, it belongs to the bot's parse output per the contract)
GET  /api/profile/uploads                → [ { id, filename, sha256, uploadedAt, jobId, jobStatus } ]
                                            (docs/PROFILE_PAGE_TABS.md T2, tab 1) — profile_uploads rows
                                            joined in code with each parse job's status, newest first; `id`
                                            is the stored upload uuid (distinct from `jobId`); metadata
                                            survives job completion. Legacy parse jobs without a
                                            profile_uploads row (pre-migration-004 uploads) still list via
                                            the old path: filename from the metadata once stashed in
                                            `result` (null once the bot overwrote it), sha256 recomputed
                                            from the file on disk.
POST /api/profile/preview                body { track } → 201 { jobId }  (docs/PROFILE_PAGE_TABS.md T1;
                                            throttled 10/hour/user; track must match ^[a-z][a-z0-9_]*$,
                                            "core" included; 409 when the caller has no stored profile;
                                            inserts a profile_jobs 'preview' row whose payload is built
                                            server-side — {profile: <caller's own stored profile>, track} —
                                            never accepted from the client; stays 'pending' until the bot's
                                            preview drain job lands, same as 'render'/'parse')
GET  /api/profile/previews               → [ { track, timestamp, files: [names] } ]  newest-first;
                                            a directory listing of users/{id}/candidate/preview/<track>/<ts>/,
                                            [] (not an error) when nothing has been rendered yet
GET  /api/profile/previews/:track/:ts/:file → the file (PDF etc.); every path component validated as
                                            path-safe before joining, 404 outside the caller's own
                                            candidate/preview/ tree
GET  /api/profile/files                  → [ { name, size, modifiedAt } ]  (docs/PROFILE_PAGE_TABS.md T2,
                                            tab 3) — the rendered files in users/{id}/candidate/,
                                            WHITELIST-ONLY: candidate.yaml, candidate_profile.md,
                                            base_cv_<slug>.md (slug ^[a-z][a-z0-9_]*$), generation_rules
                                            .local.md, profile.json. [] (not an error) for a never-rendered
                                            user; a preview/ subfolder or any other file present is silently
                                            excluded, never listed.
GET  /api/profile/files/:name            → file content, read-only (no PUT/DELETE exists for these paths
                                            — bot plan decision #6, one-way DB → files). `:name` must match
                                            the whitelist EXACTLY before it ever reaches the filesystem —
                                            traversal, absolute paths and off-list names all 404 the same
                                            as a whitelisted name that doesn't exist on disk.

# Telegram (JWT required)
POST /api/telegram/link-code → { code, expiresAt }  (6-char, 10-min)
GET  /api/telegram/status    → { linked: boolean, chatId? }

# Admin (JWT required, role=admin)
GET    /api/admin/users
PATCH  /api/admin/users/:id  { disabled?: boolean }  (400 non-boolean, 404 unknown id,
                              403 when an admin disables their own account)
DELETE /api/admin/users/:id  (also erases profiles/profile_revisions/profile_uploads + profile_jobs rows;
                              404 unknown id, 403 when an admin deletes their own account)

# Health (public)
GET /health → { status: "ok" }
```

---

## Related repos

- **`job-hunter-site`** — Angular frontend, its own Docker image
  (`ghcr.io/igrdevelop/job-hunter-site`) and deploy pipeline, path-routed to
  the same hostname by Cloudflare Tunnel. See its `CLAUDE.md` for details.
- **`job-hunter`** — Python bot (writes tracker.db + Applications/)

Full cross-repo plan: `docs/WEB_APP_PLAN.md` in the bot repo.

---

## Conventions

- Active branch: **`master`**.
- Don't commit `.env`, `data/`, `dist/`, `node_modules/`.
- Use `better-sqlite3` for all DB access (no TypeORM for tracker reads).
- All `/api/*` routes require JWT. `/auth/*` and `/health` are public.
- PRs get a CodeRabbit review, but it must be **triggered by hand**: the free
  open-source tier does not auto-review a repository with fewer than 10 GitHub
  stars (this one has 0 — observed across these repos from 2026-09-08, the bot
  repo's `docs/AGENT_LOG.md` has the PR numbers), so `auto_review.enabled: true`
  in `.coderabbit.yaml` is inert — post `@coderabbitai review` as a comment on
  the PR after opening it, and treat "no review at all" as untriggered, never
  as "no findings". That file also carries a digest of these invariants —
  update it when they change; this file stays the source of truth. Same setup
  in the bot and site repos.
- Open PRs via the `/pr` command (`.claude/commands/pr.md`): branch-from-
  current-origin/master hygiene, build + lint + test gates, and a mandatory
  code-review pass on the diff BEFORE the PR opens (CodeRabbit only sees it
  after it is public).

---

## Agent Work Log

> Append a dated entry after significant work. Format: `YYYY-MM-DD | agent | what`

| Date | Agent | Work |
|------|-------|------|
| 2026-08-04 | opus | Created project structure: CLAUDE.md, docs/SETUP.md (scaffold instructions), docs/IMPLEMENTATION_PLAN.md (A0-A4 backend steps). Project not yet scaffolded — run SETUP.md first. |
| 2026-08-04 | sonnet | Ran SETUP.md (scaffold, deps, .env) and A0-A4 of IMPLEMENTATION_PLAN.md. Corrections vs. the plan: (1) Nest 11's bundled path-to-regexp rejects `(.*)` wildcards — use `{*path}`; (2) the SPA-fallback middleware must be registered after `app.init()` or it shadows Nest's own routes (health/api/auth); (3) `hunter/funnel.py` (read from the sibling bot repo) shows "generated" means `ats_status` has a digit+`%`, not `folder != ''`, and `source_for_url()` is a real per-source domain table, not the loose guess in the plan's inferSource stub — both fixed in `TrackerService`/`AnalyticsService` to match. GitHub repo creation (SETUP.md Step 1) and Docker/Cloudflare Tunnel deploy (A0.4-A0.6) still pending — skipped per user choice for now. Test fixtures added: `test/fixtures/tracker.db` (real 14-row DB, copied with user approval) and `test/fixtures/Applications/` (synthetic folder tree, not real CVs). |
| 2026-08-04 | sonnet | Split the combined image into two independently deployable services. Removed the frontend build stage from `Dockerfile` (no more `--build-context`/checkout of `job-hunter-site`), removed `ServeStaticModule` from `app.module.ts` and the SPA-fallback middleware + manual `app.init()` from `main.ts`, dropped the now-unused `@nestjs/serve-static` dependency. `deploy.yml` no longer checks out `job-hunter-site`; it remains the sole writer of `docker-compose.prod.yml` (now also backs it up to `.bak` before overwriting), which gained a `frontend` service for `job-hunter-site`'s own image. Cloudflare Tunnel route needs a manual dashboard update (path-route `/api`+`/auth` to this container, catch-all to `job-hunter-frontend`) — not automatable from here, no Tunnel-scoped API credentials available. |
| 2026-08-04 | grok | Cut over `docker-compose.prod.yml` volumes from `./data/` test fixtures to the bot's live paths (`/home/deploy/job-hunter/tracker.db` rw, `Applications/` ro). Added `pragma('busy_timeout = 5000')` beside existing WAL mode in `TrackerService`/`AnalyticsService` so concurrent bot writes don't fail PATCH with immediate SQLITE_BUSY. |
| 2026-08-04 | grok | Added `unsent` to `APPLICATION_STATUSES` and special-cased `?status=unsent` to filter empty/placeholder `sent` (same placeholders as STATUS_CASE). Stats now include `unsent` count. Fixes frontend default filter 400. |
| 2026-08-04 | grok | Split file browsing: `/api/files` → `candidate/` (list/upload), `/api/generated` → Applications date/company tree, `/api/templates` persists under `candidate/templates/`. Mounted `candidate/` rw in compose. |
| 2026-08-05 | grok | Added read-only Settings: `GET /api/settings` reads bot `.env` via `BOT_ENV_PATH` (default `./data/.env`), hardcoded schema from `hunter/config.py` (~85 vars / 17 categories), secrets masked server-side. |
| 2026-08-07 | sonnet | Multi-user A1–A4: persist app.sqlite volume, versioned migration runner (001: role/email_verified/disabled, 002: email_verification_tokens), REGISTRATION_ENABLED gate, role system + RolesGuard, download-token flow (?dt= on stream endpoints), USERS_ROOT per-user storage (UserPathsService), refactored FilesService/GeneratedService/TemplatesService/TrackerService/AnalyticsService to take userId, tracker.db migrations (user_id column + indexes + user_settings/telegram tables), one-time VPS migration script, email verification (MailService, POST /auth/verify, POST /auth/resend), unverified-user 403 gate in JwtAuthGuard, rate limiting (@nestjs/throttler), admin module (GET/PATCH/DELETE /api/admin/users), per-user settings (GET/PUT /api/settings), global settings moved to /api/settings/global (admin only), Telegram link-code + status endpoints. |
| 2026-08-08 | grok | FILTERS_API M1–M3: `filters-schema.ts` (defaults transcribed from bot `filter_profile.builtin_defaults()` @145b03d) + `filters-validator.ts` (portable-regex, extend_only, stripDefaults) + shared `test/fixtures/filters_contract_v1.json` + contract unit test; FiltersModule GET/PUT `/api/filters` (atomic YAML write under `users/{id}/candidate/`); e2e with temp USERS_ROOT; wired into `app.module.ts`. |
| 2026-08-13 | grok | Stage 0 mirror bug: PATCH `/api/applications/:id` sets `sheets_dirty=1` only for mirrored columns (`sent`, `to_learn`) and only when `sheets_row IS NOT NULL`, so the bot's `resync_dirty()` picks up web edits without resurrecting sheet-deleted rows or rewriting the sheet for `app_status`. |
| 2026-08-13 | grok | PATCH accepts `reapplication`; mirrored columns are `SHEETS_MIRRORED_COLUMNS` (source of truth: bot `COLUMNS` in `hunter/gsheets_client.py`). CI `test` job now runs `npm test` [**superseded** 2026-09-14: the `test` job also runs `npm run test:e2e`]. Lint left out of CI because `npm run lint` is eslint `--fix`. |
| 2026-08-30 | sonnet | RESUME_PROFILE_STORE P1: migration 003 (`profiles`/`profile_revisions`, app.sqlite) + `ProfileModule` (GET/PUT `/api/profile`, `GET/POST /api/profile/revisions*`) modeled on FiltersModule; `profile-validate.ts` mirrors the bot's shallow PUT checks (schema_version, 3 required identity fields, variant key format, ≤1MB); `test/fixtures/profile_contract_v1.json` is a byte-copy of the bot's `candidate/profile.example.json` @ origin/master `12e5a4d`. Found and fixed a latent ordering bug in `runMigrations()`: it assumed the base `users` table already existed (only ever true because `UsersRepository` was its sole caller) — moved that `CREATE TABLE IF NOT EXISTS users` into `db/migrations.ts` itself (`USERS_SCHEMA`, exported) so any app.sqlite consumer, including the new `ProfilesRepository`, is safe regardless of DI instantiation order. Raised the Express body-parser limit to 2MB in `main.ts` (`bodyParser: false` + manual `json`/`urlencoded`) since the default 100kb sat below the documented 1MB profile ceiling. P2 (tracker.db `profile_jobs` render handoff): added the `profile_jobs` DDL to `tracker-migrations.ts` (same idempotent-create style as `user_settings`/`telegram_links`); PUT/restore now insert a `render` job (uuid, self-contained payload = the full validated JSON) via `TrackerService.db` — no cross-DB transaction with the app.sqlite upsert (not possible with two separate better-sqlite3 connections), which is why the job payload is self-contained per the doc's risk note; added `GET /api/profile/jobs/:id` (404 across users, matching FiltersModule/TrackerService's per-user scoping style). `renderJobId` is now always a real id — jobs sit `pending` until the bot's own drain job (its P2 follow-up PR) lands. P3 (upload/parse intake), P4 (erasure) not yet started. |
| 2026-08-30 | sonnet | RESUME_PROFILE_STORE P3 (upload intake + parse handoff): `POST /api/profile/uploads` (multipart, reusing FilesModule's `FileInterceptor`/`memoryStorage` plumbing) whitelists `docx\|pdf\|txt\|md` via a multer `fileFilter` (rejects before buffering — 400) and caps at 10MB via `limits.fileSize` (Nest maps multer's `LIMIT_FILE_SIZE` to 413 automatically, confirmed in `@nestjs/platform-express`'s `transformException`); stores the upload as `users/{id}/uploads/{uuid}.{ext}` — the client's original filename is only ever used, `basename()`'d, as display metadata (with a sha256) in the new `profile_jobs` row's `result` column, never as part of the actual path, so a `../`-laden filename is inert by construction (added `UserPathsService.uploadsDir`, not part of `ensureUserDirs` — created lazily on first upload like `FilesService.saveUpload`'s sub-dirs). Throttled 10/hour per authenticated user via a new `UserThrottlerGuard` (keys `ThrottlerGuard.getTracker` off `req.user.id` instead of IP — `AuthController`'s existing per-IP throttle isn't right for an already-JWT-scoped route). Generalized `ProfileService`'s job-insert helper from `createRenderJob` to `createJob(userId, kind, payload, result?)` so PUT/restore's `render` jobs and upload's `parse` jobs share one code path. |
| 2026-08-30 | sonnet | RESUME_PROFILE_STORE P4 (erasure + admin), completing the work order: `AdminService.deleteUser` now calls a new `ProfileService.eraseUser` (which deletes `profiles`/`profile_revisions` via a new `ProfilesRepository.deleteAllForUser` transaction, plus `profile_jobs` via `TrackerService.db`) before the existing `rmSync` of `users/{id}/` — no separate uploads/ cleanup needed since that directory already lived under the same tree `rmSync` was already removing. Exported `ProfileService` from `ProfileModule` and imported it into `AdminModule` (no cycle: `ProfileModule` only depends on `TrackerModule`/`UsersModule`). e2e (in `profile.e2e-spec.ts`, using the seeded owner's admin token): gives a user a profile + an upload, deletes them via `DELETE /api/admin/users/:id`, asserts zero rows left in `profiles`/`profile_revisions`/`profile_jobs` and that `uploads/` is gone. |
| 2026-08-31 | fable | Fixed a pre-existing e2e flake: `test/app.e2e-spec.ts` booted `AppModule` with the default `./data/` paths, and `TrackerService`/`AnalyticsService` open `tracker.db` without creating its parent directory (unlike `user.db.ts`/`profile.db.ts`, which mkdir theirs) — so the suite failed from a clean checkout with no `./data/` on disk. The spec now mkdtemps its own root and sets `APP_DB_PATH`/`TRACKER_DB_PATH`/`USERS_ROOT` before compiling the module, mirroring `filters.e2e-spec.ts`/`profile.e2e-spec.ts`. |
| 2026-08-30 | sonnet | Adversarial audit of the merged P1-P4 (no code defects found in the checked logic — validation, path handling, DDL, and erasure all matched the work order and held up under attack). `test/fixtures/profile_contract_v1.json` re-verified byte-identical to the bot repo's `candidate/profile.example.json` at its current master (`5ea4fb3d`) via git-blob SHA-256, not just a working-tree diff (a CRLF-vs-LF artifact from how the comparison copy was made looked like drift at first). Closed two real e2e gaps in `profile.e2e-spec.ts`: no test proved `POST /api/profile/revisions/:rev/restore` rejects a revision number that belongs to another user (code was already scoped by `user_id` in `ProfilesRepository.getRevision`, but nothing exercised it), and no test proved the upload endpoint's 10/hour throttle actually rejects the 11th request (added as a dedicated user so the count doesn't depend on how many uploads earlier tests already spent). Fixed two stale, pre-existing (not from this work order) inaccuracies in this file's endpoint table: `POST /auth/login` returns `{ accessToken }` not `{ access_token }` (`auth.service.ts`), and the auth routes are throttled 30/min not 10/min (`AuthController`'s `@Throttle`). Flagged, not changed (needs a decision, touches the cross-repo contract): `ProfileService.uploadResume` stores upload metadata (original filename + sha256) in `profile_jobs.result` at job creation, but the shared contract defines `result` as the bot's output once a job is `done` — a client polling `GET /api/profile/jobs/:id` sees a non-empty `result` while `status` is still `pending`, and the metadata is overwritten (lost) once the bot's drain job writes its real parse output there. Not fixed here because both other columns are pinned by the cross-repo contract (`payload` must stay a bare relative path for the bot's future drain code; changing `result`'s shape needs sign-off since the site's work order consumes it too). |
| 2026-08-31 | sonnet | docs/PROFILE_PAGE_TABS.md T1 (preview job flow): `POST /api/profile/preview` (validates `track` against `^[a-z][a-z0-9_]*$` — "core" already satisfies it, not a separate exception — 400 otherwise; 409 when the caller has no stored profile; the job payload `{profile, track}` is built server-side from the `profiles` table, never accepted from the client; throttled 10/hour/user via the existing `UserThrottlerGuard`; no DDL change, `kind='preview'` reuses the free-text `profile_jobs.kind` column). `GET /api/profile/previews` lists `users/{id}/candidate/preview/<track>/<ts>/` newest-first (sorted by each run folder's mtime, not the timestamp string, since the API doesn't own that format), `[]` when the tree doesn't exist. `GET /api/profile/previews/:track/:ts/:file` serves one file, modeled on `GeneratedController`'s date/company/file pattern but plain-JWT (not the `?dt=` download-token flow — the T1 doc scopes this whole surface as "all JWT, user-scoped"). New shared helper `src/profile/profile-preview.ts` (`isValidTrack`, `isPathSafeComponent`, content-type table) used by both the job-insert path and the two read endpoints, since `track` is validated for both a queue payload and a URL path segment. Path safety is two-layered: `isPathSafeComponent` rejects `/`, `\`, `..`, or empty BEFORE any join (catches a `%2f`-decoded segment Express would otherwise hand back with an embedded slash), then `safeJoin` (`src/files/safe-path.ts`) re-checks the resolved path as a second line of defense — same discipline the bot's `_resolve_user_relative_path` applies on its side of the bus. New `UserPathsService.previewDir()`. 19 new e2e cases in a dedicated `test/profile-preview.e2e-spec.ts` (own temp DB/USERS_ROOT, mirroring `profile.e2e-spec.ts`'s setup rather than appending to that file, to avoid depending on its revision-number/throttle-bucket state): pending-job payload correctness, invalid-track 400 (`it.each` over uppercase/leading-digit/slash/dot-dot/empty/space), no-profile 409, throttle 429 on the 11th request, cross-user isolation on both the jobs-poll and previews endpoints (404, not another user's data), listing sort order (planted fixture folders with controlled `mtime` via `utimesSync`), and four traversal attempts against a file planted one level up from the preview tree (`candidate/candidate.yaml`) — none reach 200 or leak content. Full suites green: unit 30/30 (unchanged), e2e 47/47 (28 existing + 19 new). Note: `npm run lint` (`eslint --fix`) reformatted ~24 unrelated files across the repo when run un-scoped — per this file's own 2026-08-13 entry lint isn't a CI gate, and those reformats were reverted before this PR; linted only the touched files instead (`eslint --no-fix <files>`), 0 problems outside the new e2e spec, which carries the same `no-unsafe-*`-on-`any` pattern already present throughout `profile.e2e-spec.ts`/`filters.e2e-spec.ts`. T2 (uploads/files read endpoints, `lastRenderJob`) and T3 (`isOwner`) are separate PRs per the work order. |
| 2026-08-31 | sonnet | docs/PROFILE_PAGE_TABS.md T3 (`isOwner` on `GET /auth/me`): new `OWNER_USER_ID` config knob (`src/config/configuration.ts`, `owner.userId`) compared against the caller's id in a new `AuthService.isOwner(userId)`, wired into `AuthController.me()`. Deliberately NOT the existing `role='admin'` (already used elsewhere in this repo, e.g. `TrackerService`'s owner backfill lookup) — `role` gates platform ADMINISTRATION (user management via `/api/admin/*`), a distinct concept from "the one person whose curated profile drives the owner-only tabs/chips"; a future multi-admin deployment must not conflate the two, per the work order's own reasoning for recommending a dedicated config knob over a roles-table read. Unset `OWNER_USER_ID` means `isOwner` is always `false`, never inferred. New `test/auth-owner.e2e-spec.ts`: since the owner's user id is a `randomUUID()` minted at seed time (not knowable before the app boots), the spec runs in two phases against the SAME on-disk `app.sqlite`/`tracker.db`/`users` root — phase 1 boots normally (no `OWNER_USER_ID` set) to seed the owner and register a second user, asserting `isOwner: false` for both while unset; phase 2 sets `OWNER_USER_ID` to the id discovered in phase 1 and boots a FRESH app instance against the same files (`AuthService.onModuleInit`'s seed step no-ops once users already exist) — mirroring how a real deployment configures the env var once the owner's id is known and restarts. JWTs minted in phase 1 stay valid in phase 2 (same `JWT_SECRET`). 3 new e2e cases: owner token → `true`, other user's token → `false`, unauthenticated → unchanged 401 with no `isOwner` in the body. Full suites green: unit 30/30 (unchanged), e2e 50/50 (47 existing + 3 new). No existing e2e spec asserted an exact `/auth/me` response shape (`.toEqual`) — all only read `.body.id` — so adding the field broke nothing. Linted only the touched files (`eslint --no-fix`): `src/config/configuration.ts` and my own new lines in `src/auth/auth.service.ts`/`auth.controller.ts` are 0-problem clean; the 5 flagged issues elsewhere in those two files (all on lines I did not touch, confirmed by linting the pristine `origin/master` copies) are pre-existing, same as the accepted `no-unsafe-*`-on-`any` pattern in the new e2e spec. Branched fresh from `origin/master` per the work order (not stacked on T2, #25) — T2 and T3 touch disjoint source files (`src/profile/*` vs `src/auth/*` + `src/config/configuration.ts`); both PRs touch this `CLAUDE.md` file, which is routine and expected to need a merge-conflict resolution on whichever of the two lands second, same as any other pair of sequential PRs in this repo's history. |
| 2026-08-31 | sonnet | docs/PROFILE_PAGE_TABS.md T2 (tab read endpoints): `GET /api/profile/files` + `GET /api/profile/files/:name` — a new `src/profile/profile-files.ts` holds the whitelist (`candidate.yaml`, `candidate_profile.md`, `base_cv_<slug>.md`, `generation_rules.local.md`, `profile.json`) and per-name content-type table; the read endpoint checks the whitelist FIRST (exact match, no wildcard) before any path ever reaches `safeJoin`/the filesystem, so traversal, absolute paths and off-list names all fail identically to a whitelisted name that's simply missing on disk — 404, never 400, since there's nothing to distinguish from the caller's side. `GET /api/profile/uploads` joins `profile_jobs` (kind='parse') rows with the upload's own uuid (parsed back out of the `uploads/{uuid}.{ext}` payload — a stable `id` distinct from `jobId`); confirmed and documented a real, pre-flagged gap (2026-08-30 work log entry): the job's `result` column holds `{filename, sha256}` ONLY until the bot's drain job overwrites it with the real parse output, so a `done`/`error` job can no longer report the original filename at all — `sha256` is still recoverable by re-hashing the uploaded file straight off disk (content-derived, so it matches regardless of when `result` was read), `filename` genuinely isn't and comes back `null`. Extended `GET /api/profile`'s response with `lastRenderJob: {id, status, updatedAt} | null` (most recent kind='render' row) — added `rowid DESC` as an explicit tiebreaker after `created_at DESC` on both this query and the new uploads-list query, since two jobs created within the same millisecond (a rapid double-PUT) would otherwise have SQLite's tie-break behavior decide "most recent" arbitrarily; `updatedAt` falls back to the job's `created_at` when the bot hasn't stamped `updated_at` yet (still `pending`). Sort order for both new listings is a plain codepoint comparator, not `localeCompare` — deliberately locale-independent for a small fixed API surface. New `test/profile-tabs.e2e-spec.ts` (own temp DB/USERS_ROOT, same standalone-file discipline as `profile-preview.e2e-spec.ts`): whitelist enforcement via `it.each` over off-list/malformed names (incl. a `%2f`-encoded traversal attempt and an uppercase/empty `base_cv_` slug), no PUT/DELETE route exists under `/files/*`, empty-listing for a never-rendered user, cross-user isolation on all three endpoints, the uploads-metadata-loss behavior exercised directly (plant a pending upload → assert full metadata, then simulate the bot's drain overwrite → assert `filename: null` but `sha256` still correct), and `lastRenderJob` null/pending/done + "a parse job in between must not be picked up as the render job". Full suites green: unit 30/30 (unchanged), e2e 70/70 (47 existing + 23 new in this file, incl. an 8-case `it.each` over off-list/malformed file names). Environment note for future agents on Windows: this checkout's `node_modules` had a genuinely corrupted `@angular-devkit/core`-nested `ajv` install (missing `dist/ajv.js`) that broke `nest build`/`nest --version` entirely (reproduced independently of this PR, in a clean `npm ci --ignore-scripts` at a short path outside the deep worktree tree — long-path truncation was briefly suspected but ruled out); worked around by installing fresh at a short path (`%TEMP%\nm-api-t2`) and junctioning it into the worktree's `node_modules`, `npm install`/`npm ci` themselves need `--ignore-scripts` on this machine since `better-sqlite3`/`bcrypt` have no Visual Studio Build Tools to compile against (both ship working prebuilt binaries that `--ignore-scripts` doesn't touch). `npm run lint` (`eslint --fix`) was NOT run unscoped; linted only the touched files (`eslint --no-fix <files>` first, then a scoped `--fix` for pure-formatting issues since none of the 4 touched files pre-existed) — `profile-files.ts`/`profile.service.ts`/`profile.controller.ts` are 0-problem clean, the new e2e spec carries only the same pre-existing `no-unsafe-*`-on-`any` pattern already present in every other e2e spec in this repo (verified by re-running eslint against `profile.e2e-spec.ts`/`profile-preview.e2e-spec.ts` unchanged — same error class, same volume). T3 (`isOwner`) is a separate PR per the work order, based on this one's merge commit since both touch `src/profile/`-adjacent files only tangentially (T3 touches `auth.controller.ts` + `configuration.ts`, no overlap). |
| 2026-09-01 | fable | Live-site fix: GET /api/profile/previews/:track/:ts/:file now carries `@Public()` + `@UseGuards(DownloadAuthGuard)` (the FilesController/GeneratedController pattern) instead of relying on the global JWT guard alone — the site opens preview files via `window.open(...?dt=<download token>)`, which cannot send an Authorization header, so every preview download failed with 401 ("Could not open the file." on the Test Resume tab, first reported by the owner minutes after deploy). ProfileModule now imports AuthModule for the guard's deps. 3 new e2e cases in profile-preview.e2e-spec.ts: the dt flow end-to-end (no auth header), user B's dt token still scoping to B (404 on A's file), and a garbage dt → 401 — the download-token flow previously had zero e2e coverage anywhere. |
| 2026-09-01 | fable | Added `.coderabbit.yaml` — CodeRabbit auto-review on every PR (free open-source tier) [**superseded**: the free tier stopped auto-reviewing repos under 10 GitHub stars, observed here from 2026-09-08; every PR now needs a manual `@coderabbitai review` comment]. Digest of the repo invariants: tracker.db is bot-owned (API writes only Sent/To Learn/Re-application/app_status), user-scoped queries + path-traversal protection in files/generated/templates modules, JWT guards, class-validator DTOs, synchronous better-sqlite3 on hot paths, deploy.yml as sole docker-compose.prod.yml writer, cross-repo contract stability (profile_jobs, RESUME_PROFILE_STORE.md). Same setup added to the bot and site repos in the same change. Activation: owner installs the CodeRabbit GitHub App on the repo. |
| 2026-09-01 | fable | Added `.claude/commands/pr.md` — local `/pr` pre-flight: branch hygiene (cut from current origin/master, never rebase), `npm run build` + eslint (no `--fix`) + jest gates, then a mandatory `code-review` skill pass on the diff (CONFIRMED correctness findings are a hard stop) before `gh pr create`. Mirrors the bot repo's `/pr`; CodeRabbit remains the post-publication reviewer. |
| 2026-09-01 | fable | isOwner rebased onto `role='admin'` (live incident, same day): the deploy workflow is the sole writer of BOTH `docker-compose.prod.yml` and `.env` on the VPS, so the hand-configured `OWNER_USER_ID` was wiped on the very next deploy and the owner's own owner-only tabs vanished from the live site. `AuthService.isOwner()` now returns `role==='admin'` with zero configuration; `OWNER_USER_ID` remains honored as an optional NARROWING override (when set, it alone decides — covered by reworked `auth-owner.e2e-spec.ts` phase 2, which now points the override at the non-admin user and asserts the admin LOSES isOwner while the named user gains it). Config/env-table comments updated. |
| 2026-09-14 | sonnet | api half (A1-A4) of "Applications table: My Status drives Sent, Note column, instant refresh" (approved plan, site half is S1-S5 in `job-hunter-site`) [**superseded same day**: the owner reviewed this locally and asked for structured decline reasons instead of free text — the `note` column described below was removed a few hours later without ever being deployed; see the very next work log entry]. A1: `note TEXT NOT NULL DEFAULT ''` added to `tracker-migrations.ts`, same idempotent-guard style as `app_status`. A2: `note` added to `APPLICATION_COLUMNS`, the `Application` DTO, and `UpdateApplicationDto` (`@IsString @MaxLength(2000)`); never mirrored to Sheets. A3: new `src/tracker/app-status.ts` (`APP_STATUS_OPTIONS`, `APPLIED_STATUSES`, `NOT_APPLYING_STATUSES`, `OUTCOME_BY_STATUS`, `DASH_MARKERS`, plus `todayIsoDate()`/`nowIsoSeconds()`); `UpdateApplicationDto.appStatus` gets `@IsIn(APP_STATUS_OPTIONS)`. The controller's four separate `tracker.updateX()` calls collapsed into one transactional `TrackerService.updateApplication(userId, id, dto)` implementing the plan's mapping table: an "applied" status (Sent/Interview/Rejected/Offer/Silence) fills a blank-or-dash `sent` with today's date and, for the four with a bot outcome label, sets `outcome_label`/`outcome_at` (only when the label actually differs — never re-stamps, never clears); a "not applying" status (Skipped/Filter miss) fills a genuinely-blank `sent` with the bot's own em-dash marker; derivation is skipped entirely when the same PATCH body also sends an explicit `sent` (that edit always wins). `outcome_label`/`outcome_at` writes are skipped with no crash when a live PRAGMA check finds the columns absent (older tracker.db, bot hasn't migrated yet — checked live, not cached, since the bot can add them independently of this process's lifecycle) and otherwise follow the exact same "dirty only when `sheets_row IS NOT NULL`" rule as a mirrored column, matching the plan's explicit call to keep the API's orphan-row guard even though the bot's own `set_outcome()` dirties unconditionally. **Timezone decision** (plan asked to check the bot's TZ and document the choice): neither this repo's `Dockerfile` (`node:22-alpine`) nor the bot repo's (`python:3.11-slim`, checked via `git show origin/master:Dockerfile`) nor either `docker-compose*.yml` sets `TZ` — both containers currently default to UTC coincidentally, not by design — while the bot names an explicit zone for its own day-boundary logic (`hunter/config.py::TIMEZONE = "Europe/Warsaw"`, the owner's real timezone, used today only for Telegram scheduling). Rather than lean on two containers' matching-by-accident UTC default, `todayIsoDate()` hardcodes `Europe/Warsaw` via `Intl.DateTimeFormat('en-CA', {timeZone})`, matching the plan's suggested default and the bot's own named zone. A4: `tracker.service.spec.ts` rewritten — two schema fixtures (with/without `outcome_label`/`outcome_at`, the latter proving the no-crash path) plus a DTO-validation block (`@IsIn`/`@MaxLength` via `class-validator`'s `validate()`) and a `runTrackerMigrations` idempotency test (run twice, no throw, exactly one `note`/`app_status` column) — 70 unit tests total (was 30). **Contradicted the plan in one place, flagged not silently deviated:** the plan's rule read as gating only the sent-side effect on an explicit-`sent` PATCH body ("Derivation runs only if the same PATCH body does not contain `sent`"), but its own A4 test bullet says "explicit `sent` in the same body suppresses derivation" with no qualifier — implemented as full suppression (outcome derivation also skipped, not just the sent fill), matching the more literal, test-driven reading and the plan's own rationale ("lets a client restore both fields exactly"); worth a second look if a future PATCH ever legitimately wants to set `sent` AND still record an outcome in one call. Also tightened (not preserved) one edge case: PATCH with a completely empty body (`{}`) against an unknown/other-user id now 404s via the new single existence check at the top of the transaction, where the old per-field-call controller silently returned `null` for that case since no individual `updateX()` ever ran — a correctness improvement, not requested by the plan, called out here since "404 behavior unchanged" was an explicit requirement. Docs: `.coderabbit.yaml` and `.claude/commands/pr.md` writable-column mentions extended with `note` and the derived `outcome_label`/`outcome_at`. Gates: `npm run build` clean, `npm test` 70/70, `npx eslint` (scoped to the 7 touched/new files, matching this repo's own no-unscoped-`--fix` convention) 0 problems after fixing two real issues surfaced by the first lint pass — `SHEETS_MIRRORED_COLUMNS` had gone value-unused after the initial `setColumn(..., mirrored: boolean)` design, refactored so `setColumn` derives `mirrored` itself from that same list instead of trusting each call site to pass the right boolean — plus prettier-only formatting, none of it touching files outside this change. Environment note for future agents on this machine: plain `npm ci` fails (`better-sqlite3` has no Visual Studio Build Tools to compile against here); `npm ci --ignore-scripts` works since the prebuilt binary ships regardless, confirmed by loading it standalone (`require('better-sqlite3')(':memory:')`) before relying on it. Worktree: `D:\Projects\job-hunter\api-worktrees\applications-status-note`, branch `feat/applications-status-note`. Not pushed, no PR opened — left for the owner to decide, per the work order. |
| 2026-09-14 | sonnet | api half of "Applications table v2: status menu, decline reasons, filter-miss feedback" (round 2, approved plan; site half is a separate agent's work in `job-hunter-site`). New commit on the same `feat/applications-status-note` branch, on top of the round-1 commit (not amended). **Removed `note` entirely** (it was never deployed, so no DROP-COLUMN migration was needed — just deleted the ALTER from `tracker-migrations.ts`, and every DTO/SELECT/service/spec/docs mention). **Added two new api-owned, non-mirrored columns**: `owner_reason TEXT NOT NULL DEFAULT ''` / `owner_reason_note TEXT NOT NULL DEFAULT ''` (JSON `ownerReason`/`ownerReasonNote`), same idempotent-migration-guard style as `app_status`, deliberately named apart from the bot's own gate-only `skip_reason` so the two can never be confused. New `OWNER_REASON_CODES`/`OWNER_REASONS`/`isOwnerReasonAllowedForStatus()` in `src/tracker/app-status.ts` — the 16-code table from the plan, with `salary`/`not_interesting` allowed for `Skipped` only and every other code allowed for both `Skipped` and `Filter miss`; exported so the site can mirror the codes (with labels) into its own `models.ts`. `UpdateApplicationDto.ownerReason` validates via `@IsIn([...OWNER_REASON_CODES, ''])` (unknown code → 400 automatically, before the request reaches the service); `ownerReasonNote` gets `@MaxLength(500)` (was 2000 for the removed `note`). **PATCH rules**, all inside `TrackerService.updateApplication`'s existing single transaction (current row's `sent`+`app_status`(+`outcome_label`) now selected together at the top): a non-empty `ownerReason` is checked against the *resulting* status — this body's `appStatus` if present, else the row's current `app_status` — via `OWNER_REASONS`' per-status allowlist; a mismatch (including any non-empty reason when the resulting status isn't `Skipped`/`Filter miss` — a non-decline status is simply never in any code's `allowedFor`, so this is the same check, not a separate branch) throws `BadRequestException` before any column is written. Whenever the body's own `appStatus` resolves to something other than `Skipped`/`Filter miss` (including explicit `''`), both `owner_reason` and `owner_reason_note` are unconditionally reset to `''` in the same transaction — a status correction can never leave a stale reason behind; this is safe from ever fighting the validation above, since a non-empty `ownerReason` on that same non-decline `appStatus` would already have been rejected. `ownerReason`/`ownerReasonNote` were added to `SHEETS_MIRRORED_COLUMNS`'s exclusion list alongside `app_status` — same "API-owned, never dirties the sheet" treatment. Existing `sent`/outcome derivation (`deriveFromAppStatus`) is untouched. The reset is keyed off the *resulting* status (not only a body `appStatus`), so a lone `ownerReasonNote` patched onto a non-decline row is dropped too instead of persisting as an orphan comment (coordinator follow-up after a live smoke found that gap; spec "drops a lone ownerReasonNote patched onto a non-decline row"). Rewrote the `ownerReason`/`ownerReasonNote` block of `tracker.service.spec.ts` (the round-1 note tests were replaced, not appended) covering: save + round-trip on Skipped/Filter miss, allowed-per-current-status when `appStatus` is absent from the body, the two 400 cases (code not allowed for the resulting status; e.g. `salary`+`Filter miss`, and non-empty reason on a non-decline resulting status) each asserting nothing was written, explicit `''` always allowed, both fields cleared when `appStatus` moves off decline (including to `''`), fields left untouched when a decline status is re-sent without mentioning reason, a reason-only PATCH against an already-Skipped row, and that the reason fields alone never dirty the sheet (isolated from the separately-tested `sent`-derivation dirty behavior via a pre-set real `sent` date, since the first version of this test wrongly expected `sheets_dirty: 0` while also triggering a first-time dash-marker `sent` fill on a live sheet row — caught by running the suite, not just reasoning about it). Migration-idempotency test now asserts exactly one each of `app_status`/`owner_reason`/`owner_reason_note` after running twice. DTO-validation block covers known/empty/unknown `ownerReason` and the 500-char `ownerReasonNote` boundary (500 exact = pass, 501 = fail). Docs: `.coderabbit.yaml` and `.claude/commands/pr.md` writable-column mentions updated (`note` → `owner_reason`/`owner_reason_note`); `CLAUDE.md`'s endpoint table PATCH line extended with the two new fields and their 400/clear rules; this row. No `docs/DOMAIN_MODEL.md` exists in this repo (that doc lives in the bot repo, out of scope for this api-only task). Gates: `npm run build` clean, `npm test` 83/83 (was 70 before this commit — 13 net new: removed the 3 note-specific tests, added 16 ownerReason/ownerReasonNote tests), `npx eslint` scoped to the 6 touched files, 0 problems (two prettier-only formatting issues from a long union type and a wrapped `.includes()` call, fixed via a scoped `eslint --fix` on the single touched file already carrying no other diffs, per the round-1 entry's own precedent for isolated prettier fixes). Same worktree/branch as round 1. Not pushed, no PR opened. |
| 2026-09-14 | sonnet | Code-review follow-ups on PR #34 (owner-approved, pushed as a new commit — no amend/force-push). Five fixes, all in `src/tracker/tracker.service.ts` / `app-status.ts`: (1) **SQLITE_BUSY_SNAPSHOT**: `updateApplication`'s `db.transaction()` SELECTs the current row before writing, but the library default is DEFERRED, which takes no lock until the first statement and fixes its read snapshot there — a concurrent bot commit between that SELECT and our first write then fails the lock upgrade with SQLITE_BUSY_SNAPSHOT (a snapshot conflict, not a lock wait, so `busy_timeout` never retries it) → 500. Switched to `run.immediate()` (better-sqlite3's IMMEDIATE variant), which takes the write lock at BEGIN, before the SELECT runs. Regression test opens a second raw connection to the SAME on-disk file and, via a `jest.spyOn` hook on the service's own `db.prepare`, attempts a real concurrent write from that connection (`busy_timeout=0`, fail-fast) at the exact moment our SELECT is prepared — it can only succeed if our transaction hasn't taken the write lock yet, so asserting it throws is a working proxy for "this transaction is IMMEDIATE" (better-sqlite3 doesn't expose the literal BEGIN SQL through the public `prepare()`, confirmed by spiking it standalone, so the SQL text itself isn't directly observable). (2) **Stale owner_reason across a decline-to-decline status change**: PATCH `{appStatus:'Filter miss'}` with no `ownerReason` in the body, on a row whose stored `owner_reason` was `'salary'` (Skipped-only), used to leave that now-invalid combination in place — the existing "moved off decline clears both" reset never fired because Filter miss is STILL a decline status. Added an `else if` branch: when the body omits `ownerReason` and the resulting status stays Skipped/Filter miss, the STORED reason is re-checked against the resulting status via the same `isOwnerReasonAllowedForStatus()` and cleared (note left alone — free text may still be accurate) if it's no longer valid there. Required selecting `owner_reason` in the initial row read. (3) **Undo for a mis-clicked decline**: `appStatus: ''` (Clear) with no `sent` in the body, on a row that WAS Skipped/Filter miss with `sent` still the bot-style dash marker THIS api wrote, now also clears `sent` back to `''` (through the normal `setColumn` dirty rule) — `deriveFromAppStatus` gained an `else if (status === '')` branch keyed off a new `previousStatus` parameter (the row's `app_status` before this PATCH). Deliberately narrow: never touches a bot-written dash on a row whose appStatus was never a decline value (that dash is the bot's own SKIP/FAIL stamp and must not resurface the row in Unsent), never a real date/EXPIRED/free text, and never `outcome_label`/`outcome_at` (clearing those stays Telegram `/outcome <id> clear` — the bot's Sheet-pull would silently undo an api-side clear, same reasoning the existing "never clear an outcome" comment already documents). (4) **Explicit reason/note contradiction**: the body sending a non-empty `ownerReasonNote` together with an explicit `ownerReason: ''` in the same PATCH now 400s before any write (self-contradictory: clearing the reason while attaching a comment to it) — a body that clears `ownerReason` alone, without mentioning the note, is NOT rejected and leaves the stored note as-is (simpler than guessing intent, matches the review's "prefer 400 only for the explicit contradiction" instruction). (5) **outcome_at format**: `nowIsoSeconds()` produced `...Z`, but the bot's `hunter/tracker.py::set_outcome`/`mark_orphans_expired` write `datetime.now(timezone.utc).isoformat(timespec="seconds")`, which for an aware UTC datetime is `YYYY-MM-DDTHH:MM:SS+00:00` — verified via `git show origin/master:hunter/tracker.py` in the bot repo, not assumed. Fixed to emit `+00:00`; updated the stale doc-comment (that used to literally claim the wrong shape) and the one existing spec assertion (`outcomeState().outcome_at` regex) that had been silently passing against the wrong format the whole time. New tests: 25 net new in `tracker.service.spec.ts` (97 total, was 83+the outcome_at regex fix) covering all five fixes — stale-reason-cleared / still-valid-reason-preserved across a decline-to-decline transition, the contradiction 400 plus its two non-rejected siblings (clear-alone, both-explicitly-cleared), Clear-undoes-the-dash for both decline statuses (`it.each`), Clear-does-NOT-touch a non-decline row's bot-written dash, a real date, sheets_dirty still following the normal rule on the cleared write, an explicit `sent` in the same body still suppressing Clear's own derivation too, and the transaction-locking regression test. `npm run build` clean, `npm test` 97/97 (2 pre-existing e2e failures in `profile-preview.e2e-spec.ts`, unrelated to this change — confirmed by running `npm run test:e2e` against the unmodified branch first, same 2 failures), `npx eslint --no-fix` on the 3 touched files 0 problems (one prettier-only reformat in `tracker.service.ts` from the new `previousStatus` parameter, applied via a scoped `--fix` on that single file per this doc's own precedent; the spec file's `jest.spyOn(...).bind()` needed an explicit function-type cast instead of relying on inference, since binding a generic method like better-sqlite3's `prepare` otherwise resolves to `any` under this repo's `no-unsafe-*` rules — documented inline). Updated the endpoint table's PATCH line and this row; `.coderabbit.yaml`/`.claude/commands/pr.md` needed no change (writable-column list unaffected — no new column, just behavior refinements on the two already listed there). Same worktree/branch, new commit on top of round 2 (not amended). |
| 2026-09-14 | opus | Fixed two e2e tests in `test/profile-preview.e2e-spec.ts` that had failed with 404 on master since the 2026-09-01 dt-flow fix: they requested `/api/auth/download-token`, but `auth/{*path}` is excluded from the global `api` prefix (`main.ts` and every spec's setup), so the real route is `/auth/download-token`. The "B's dt cannot fetch A's file" case gained a positive control (the same dt token fetches B's own planted file → 200), so its 404 provably comes from user scoping, not a rejected token; verified by mutation that disabling the guard's `?dt=` branch makes both dt cases fail. Root cause they went unnoticed: `deploy.yml`'s `test` job ran only `npm test` (unit, `rootDir: src`) — added a `npm run test:e2e` step after unit tests, before build (test job only; deploy job untouched). e2e specs are CI-safe on a clean runner: every spec mkdtemps its own DB/USERS_ROOT and only reads committed `test/fixtures/`, nothing from gitignored `data/` or `.env`. No other `/api/auth`/`/api/health` misuse in any spec. Local: unit + e2e (76/76) green. Not changed: `.claude/commands/pr.md` gates still run only `npm test`, not e2e. |
| 2026-08-31 | fable | Durable upload metadata — properly fixes the `profile_jobs.result` gap flagged 2026-08-30 and re-confirmed in the T2 entry. Migration 004 (app.sqlite): `profile_uploads` (id = stored upload uuid, user_id, filename, sha256, stored_path, job_id, created_at + user_id index; `job_id` is a soft reference into tracker.db's `profile_jobs` — no FK across databases). `ProfileService.uploadResume` now writes that row at POST time and inserts the parse job with an EMPTY `result` — the metadata stash in `result` is gone, restoring the shared contract (`result` = the bot's output once a job completes; a poller no longer sees a non-empty `result` on a pending job), so the long-flagged cross-repo ambiguity is resolved API-side without touching `payload`'s shape or anything the bot drains. `GET /api/profile/uploads` serves from `profile_uploads` joined in code (two DBs) with each job's status; `filename`/`sha256` now survive `done`/`error`. Kept a legacy fallback for parse jobs with no `profile_uploads` row (uploads made before this migration exist in production tracker.db, POST has been live since P3): old behavior — filename from `tryParseUploadMetadata(result)` while pending, `null` after the bot overwrote it, sha256 re-hashed from disk; a metadata row whose job row vanished reports `jobStatus: 'unknown'` rather than faking `pending`. Erasure: `ProfilesRepository.deleteAllForUser` wipes `profile_uploads` in the same transaction as `profiles`/`profile_revisions`, so the existing `AdminService.deleteUser` → `ProfileService.eraseUser` path needed no wiring change — e2e asserts zero `profile_uploads` rows post-delete. Tests updated: `profile.e2e-spec.ts` upload assertions moved from `result`-metadata to the `profile_uploads` row (+ `result` asserted empty at creation), `profile-tabs.e2e-spec.ts`'s "filename is unrecoverable" flipped to "filename survives completion", plus new legacy-fallback (pending + done planted job rows) and vanished-job-row cases. Suites green: unit 30/30, e2e 72/72. Built with the same short-path junctioned `node_modules` workaround as the T2 entry (`npm ci --ignore-scripts` at `%TEMP%\jhapi_nm`). Stacked on PR #25's branch (`claude/profile-page-tabs-t2`) since `GET /api/profile/uploads` only exists there. [**Never reached master** — see the 2026-09-14 re-land entry below.] |
| 2026-09-14 | opus | Re-landed the durable upload metadata change (the 2026-08-31 `profile_uploads` entry above) — it had been stranded off master. Incident: PR #27 (commit `40cf2bac`) targeted the stacked branch `claude/profile-page-tabs-t2`, and was merged into that branch ~9 seconds AFTER the branch itself (PR #25) had already merged to master; GitHub does not retarget or re-propagate a PR merged into an already-merged base, so #27 showed "merged" while master never got it (`git merge-base --is-ancestor 40cf2bac origin/master` false). Production kept the pre-fix behavior for two weeks: `ProfileService.uploadResume` stashed `{filename, sha256}` in `profile_jobs.result`, which the bot's drain job overwrites, so `GET /api/profile/uploads` lost the filename of every completed upload. Fix: `git cherry-pick 40cf2bac` onto a fresh branch from `origin/master`. Source files auto-merged against everything that landed since (T3 `isOwner` on `role='admin'`, the preview `?dt=` download-token fix, docs/CodeRabbit changes) — none of them touch `src/db/migrations.ts`'s version list or the upload paths; migration 004 re-verified as the next free version (master tops out at 003). The only conflict was this file's work log tail (both sides appended rows) — resolved by keeping master's 2026-09-01 rows followed by the original 2026-08-31 entry, annotated as stranded, plus this row; also updated the endpoint table's admin DELETE line and Profile section header to name `profile_uploads`. Re-checked the invariants: `profile_jobs.payload` stays the bare `uploads/{uuid}.{ext}` path (bot contract), `createJob` inserts an empty `result` for render/parse/preview alike, `ProfilesRepository.deleteAllForUser` wipes `profile_uploads` in the same transaction, and the legacy fallback (parse jobs with no `profile_uploads` row — i.e. every upload made in production before this deploy) still lists them. Gates: build clean; unit 30/30; e2e 76/78 — the 2 failures are the pre-existing `test/profile-preview.e2e-spec.ts` `?dt=` cases calling `/api/auth/download-token` instead of `/auth/download-token`, identical on master (74/76), fixed on a separate branch. Lessons: when a stacked base branch merges first, retarget the child PR to master before merging it, and confirm with `git merge-base --is-ancestor <sha> origin/master` after merge. |
| 2026-09-14 | opus | Fixed 500s on file downloads with non-ASCII names: all five download routes (`FilesController`, `GeneratedController`, `TemplatesController`, `ProfileController` preview + candidate file) hand-built `Content-Disposition: ...; filename="<name>"`, and Node rejects header values with chars above U+00FF (`ERR_INVALID_CHAR`) — so any Polish company folder/file from the bot (`Wrocław_CV.pdf`) or a Cyrillic template name 500'd, and U+0080–U+00FF names went out as latin1 mojibake. New shared `src/common/content-disposition.ts` emits RFC 6266 `<type>; filename="<ASCII fallback>"; filename*=UTF-8''<RFC 5987>` (fallback: NFKD + strip combining marks, other non-ASCII → `_`, `"`/`\` removed, control chars incl. CR/LF dropped from both params, lone surrogates → U+FFFD so `encodeURIComponent` can't throw, empty → `download`; `'()*` percent-encoded on top of `encodeURIComponent`). Hand-written rather than the `content-disposition` package: it is only a transitive dep (via express), for latin1-only names it emits the raw U+0080–U+00FF chars in `filename=` with no `filename*` (the mojibake case above), and its fallback is not configurable to ASCII-only without passing a precomputed fallback — i.e. writing most of this helper anyway, plus a package.json entry. Inline/attachment decisions and content types unchanged. New unit spec (14 cases, checks each header with Node's own `http.validateHeaderValue`) and `test/content-disposition.e2e-spec.ts` (generated Polish file, candidate Polish file, Cyrillic-named template — all 3 confirmed 500 on the old controllers before the fix). Unit 44/44; e2e 77/79, the 2 failures are the pre-existing `profile-preview.e2e-spec.ts` `/api/auth/download-token` ones fixed on another branch. |
| 2026-09-14 | opus | Closed three ValidationPipe bypasses: the global `ValidationPipe` only validates parameters typed with a decorated CLASS, so `PATCH /api/admin/users/:id` (`@Body() body: { disabled?: boolean }`, an erased inline type) accepted `{"disabled":"false"}` — truthy, so it DISABLED the user — and `POST /auth/verify`/`/auth/resend` (`@Body('token')`/`@Body('email')`) let an object reach better-sqlite3, which throws `RangeError` → 500. New DTOs `UpdateUserDto` (`src/admin/dto/`; `@ValidateIf(present) @IsBoolean()` rather than `@IsOptional()`, which would also wave an explicit `null` through), `VerifyEmailDto`, `ResendVerificationDto` (`src/auth/dto/`). PATCH on an unknown id now 404s (was 200 with an empty body). An admin disabling (`disabled: true`) or deleting their OWN account now gets 403 — 403 rather than 400 because the body is well-formed; it is a policy refusal of who may act on whom, and on the single-admin VPS it would lock the deployment out of administration (`{disabled:false}` on self stays allowed, a no-op). Resend's no-existence-leak behavior unchanged. Note for test authors: e2e specs build the app via `Test.createTestingModule`, NOT `src/main.ts`, so none of them had the global pipe before — the new `test/admin-auth-validation.e2e-spec.ts` installs the same pipe explicitly. 16 new e2e cases (13 of them fail against the old controllers). |
| 2026-09-14 | opus | Auth throttle keyed on the real client IP: `AuthController` used the stock `ThrottlerGuard` (tracker = `req.ip`), but in production every request arrives from the `cloudflared` container over the compose network and `main.ts` sets no `trust proxy`, so all visitors shared ONE 30/min bucket — anyone could exhaust it and lock the owner out of `/auth/login`. New `src/auth/client-ip-throttler.guard.ts` (`ClientIpThrottlerGuard`) keys on `CF-Connecting-IP` (first value only, must pass `net.isIP`), falling back to `req.ip`; the per-user upload/preview `UserThrottlerGuard` is untouched. **Exposure assumption this depends on:** the API port is reachable only through the tunnel — `docker-compose.prod.yml` binds it to `127.0.0.1:3000` and cloudflared reaches `http://job-hunter-api:3000` on the compose network. If the port is ever published on a public interface or another ingress is added, `CF-Connecting-IP` becomes client-forgeable (unlimited login attempts, worse than before) — revisit the guard first. New `test/auth-throttle.e2e-spec.ts` (own temp DB/USERS_ROOT): distinct header IPs get independent buckets, the 31st request from one IP → 429, a comma list uses its first entry, a missing/invalid header falls back to the `req.ip` bucket; confirmed both cases fail against the stock guard. |
| 2026-09-14 | opus | Auth token hardening (two verified security findings). (A) `GET /auth/download-token`'s 5-min `aud='download'` JWT (lives in URLs/history/proxy logs) was accepted as a full `Authorization: Bearer` token by the global `JwtStrategy` — passport-jwt/jsonwebtoken only check `aud` when an audience option is configured. `JwtStrategy.validate` now rejects the download audience explicitly (string or array `aud`); it deliberately does NOT start requiring an `aud` on access tokens, since existing 7-day production tokens carry none. `DownloadAuthGuard`'s bearer path rejects it too, so a download token is valid only as `?dt=`. (B) Disabled/deleted users kept access until token expiry (up to 7 days) and `role` was trusted from the token: new `src/auth/authenticated-user.ts` (`resolveActiveUser`, `assertEmailVerified`, `hasDownloadAudience`, `DOWNLOAD_AUDIENCE`) is shared by `JwtStrategy` and `DownloadAuthGuard` (both its `?dt=` and bearer paths) — missing or `disabled` row → 401, `role`/`email` taken from the DB row. `JwtAuthGuard.handleRequest` keeps its email-verified gate (admins bypass) via the shared helper. Decision: `DownloadAuthGuard` now enforces the same email-verified gate (403) — previously an unverified user's bearer token passed on the `@Public()` file routes while 403ing everywhere else, and consistency costs nothing (an unverified user could not mint a `?dt=` token anyway). Prod-logout check: a token keeps working exactly when its `sub` is an existing, enabled row (the owner's is, with DB role `admin`), so only sessions of disabled/deleted accounts end; the site (`job-hunter-site`) only ever sends download tokens as `?dt=` (grepped). New standalone `test/auth-hardening.e2e-spec.ts` (own temp DBs/USERS_ROOT), 13 cases: dt-as-Bearer → 401 on `/api/applications`, `/api/filters`, `/api/admin/users` (admin's dt) and a file route; dt via `?dt=` → 200; access token as `?dt=` → 401; admin-disabled user's access + dt tokens → 401 on `/api/*`, file routes, `/auth/me`, `/auth/download-token` (and re-enable restores them); deleted user's tokens → 401; DB demotion revokes `/api/admin/users` from an admin-claim token and DB promotion grants it to a user-claim token; unverified bearer → 403 on a file route until verified in the DB. 10 of the 13 fail against origin/master's `src/` (the other 3 are controls). Suites: unit 30/30; e2e 87/89 — the 2 failures are the pre-existing `/api/auth/download-token` URL mistake in `profile-preview.e2e-spec.ts` (baseline 74/76, fixed on another branch). Linted touched files with `eslint --no-fix`: clean except 5 pre-existing issues on untouched lines of `jwt.guard.ts` (identical on origin/master). |
| 2026-09-24 | opus | docs/PIPELINE_VIZ_PLAN.md M2, API side: `GET /api/pipeline/snapshot?days=1..30` (new `PipelineModule`, no owner gate — plan open question 4). `src/pipeline/pipeline-snapshot.ts` ports the bot's reference `tools/pipeline_snapshot.py` against its `docs/PIPELINE_SNAPSHOT_CONTRACT.md` (incl. #296's `run.refine_target`/`refine_max_rounds` and `events[].details` — parsed from the FULL payload column, `_event_details` — from bot branch `feat/snapshot-event-details`), minus the contract's "Not in the contract" keys; `sent-parse.ts` ports `hunter/sent_parse.py`; `snapshot-time.ts` computes the Warsaw calendar-day window explicitly via Intl (never the process TZ, DST-tested) and a Python-compatible `round()` (ties to even). Own `readonly` better-sqlite3 handle opened lazily (TrackerService's is read-write and migrates), all reads in ONE read transaction; every optional table/column is probed (`sqlite_master`/`PRAGMA table_info`) and degrades to `null`, missing `applications` → 503. Deliberate deviations from the tool, all identical on the one-user fixture: the in-progress run lookup and the events footer are user-scoped (the tool's footer is global and its company subquery can pick another user's row), `url_norm != ''` added to that subquery, `fail_count`/`claimed_at`/`cost_usd` probed (the tool selects them unconditionally), a partially-migrated optional table counts as missing (the tool probes only hunt_runs, and not its `id`), and `last_event`/`refine_progress` carry a raw `ts` in place of the dropped `at`. `apply.failures.log_records` reads `APPLY_FAILURES_LOG_PATH` — unset in prod because the bot's `logs/` isn't mounted here, so it is `null`. Fixtures in `test/fixtures/pipeline_snapshot/` (`schema.sql` generated from the bot's own DDL, `fixture.sql`/`expected.json` copied from the contract); the unit spec asserts exact deep equality with the contract's expected.json (after dropping the out-of-contract keys) under an injected clock, the e2e re-owns the fixture rows by two real accounts and checks the same through JWT + scoping + `days` validation. Snapshot over the fixture: ~6 ms cold. Not indexed on the bot side: `source_runs.ts` (ring buffer, small) and `pipeline_events.ts` (unpruned; the footer's ORDER BY sorts it) — a bot-side follow-up. |
