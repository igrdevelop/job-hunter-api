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
  its revision history). NestJS owns schema for both.
- `tracker.db` — bot's DB, mounted via Docker volume. Bot owns schema;
  NestJS reads freely + writes only Sent/To Learn/Re-application. Also has
  `profile_jobs` (render/parse handoff, API writes/bot drains — same
  precedent as `telegram_link_codes`; the bot's own drain job is a follow-up
  in its repo, see docs/RESUME_PROFILE_STORE.md P2 coordination note).

**Shared Docker volumes with Python bot:**
- `tracker.db` — read-write (bot writes applications, NestJS edits 3 fields)
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
the sole owner/writer of that compose file.

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

---

## API endpoints

```
# Auth (public, rate-limited: 30/min per IP)
POST /auth/register        { email, password } → { id, email }   (gated by REGISTRATION_ENABLED)
POST /auth/login           { email, password } → { accessToken }
POST /auth/verify          { token }           → { ok: true }
POST /auth/resend          { email }           → { ok: true }

# Auth (JWT required)
GET  /auth/me              → { id, email, role, emailVerified }
GET  /auth/download-token  → { token }  (5-min aud='download' JWT for window.open)

# Applications (JWT required, user-scoped)
GET    /api/applications        ?page=&limit=&sort=&order=&status=&search=
GET    /api/applications/stats  → { total, unsent, filled }
GET    /api/applications/funnel ?days=30
GET    /api/applications/:id
PATCH  /api/applications/:id    { sent?, toLearn?, reapplication?, appStatus? }

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

# Settings (JWT required)
GET /api/settings          → { key: value, ... }  (per-user whitelisted keys)
PUT /api/settings          { key: value, ... }     (upsert user_settings)
GET /api/settings/global   → { categories: [...] } (admin only, masked bot .env)

# Filters (JWT required) — users/{id}/candidate/filters.yaml
GET /api/filters           → { defaults, overrides, effective, meta }
PUT /api/filters           body=overrides only → fresh GET payload (400 + per-field errors)

# Profile (JWT required) — structured resume profile, app.sqlite (profiles/profile_revisions)
GET  /api/profile                        → { profile, revision, updatedAt }  (404 if none yet)
PUT  /api/profile                        body=full document → { revision, renderJobId }
                                            (inserts a profile_jobs 'render' row in tracker.db;
                                             stays 'pending' until the bot's drain job lands)
GET  /api/profile/revisions              → [ { rev, createdAt } ]  (newest first, last 20 kept)
POST /api/profile/revisions/:rev/restore → same response as PUT
GET  /api/profile/jobs/:id               → { kind, status, result?, error? }  (poll; 404 across users)
POST /api/profile/uploads                multipart file (docx|pdf|txt|md, ≤10MB) → 201 { jobId }
                                            (throttled 10/hour/user; stored as users/{id}/uploads/{uuid}.ext,
                                             original filename/sha256 kept in the job row's result only)
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

# Telegram (JWT required)
POST /api/telegram/link-code → { code, expiresAt }  (6-char, 10-min)
GET  /api/telegram/status    → { linked: boolean, chatId? }

# Admin (JWT required, role=admin)
GET    /api/admin/users
PATCH  /api/admin/users/:id  { disabled: boolean }
DELETE /api/admin/users/:id  (also erases profiles/profile_revisions + profile_jobs rows)

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
| 2026-08-13 | grok | PATCH accepts `reapplication`; mirrored columns are `SHEETS_MIRRORED_COLUMNS` (source of truth: bot `COLUMNS` in `hunter/gsheets_client.py`). CI `test` job now runs `npm test`. Lint left out of CI because `npm run lint` is eslint `--fix`. |
| 2026-08-30 | sonnet | RESUME_PROFILE_STORE P1: migration 003 (`profiles`/`profile_revisions`, app.sqlite) + `ProfileModule` (GET/PUT `/api/profile`, `GET/POST /api/profile/revisions*`) modeled on FiltersModule; `profile-validate.ts` mirrors the bot's shallow PUT checks (schema_version, 3 required identity fields, variant key format, ≤1MB); `test/fixtures/profile_contract_v1.json` is a byte-copy of the bot's `candidate/profile.example.json` @ origin/master `12e5a4d`. Found and fixed a latent ordering bug in `runMigrations()`: it assumed the base `users` table already existed (only ever true because `UsersRepository` was its sole caller) — moved that `CREATE TABLE IF NOT EXISTS users` into `db/migrations.ts` itself (`USERS_SCHEMA`, exported) so any app.sqlite consumer, including the new `ProfilesRepository`, is safe regardless of DI instantiation order. Raised the Express body-parser limit to 2MB in `main.ts` (`bodyParser: false` + manual `json`/`urlencoded`) since the default 100kb sat below the documented 1MB profile ceiling. P2 (tracker.db `profile_jobs` render handoff): added the `profile_jobs` DDL to `tracker-migrations.ts` (same idempotent-create style as `user_settings`/`telegram_links`); PUT/restore now insert a `render` job (uuid, self-contained payload = the full validated JSON) via `TrackerService.db` — no cross-DB transaction with the app.sqlite upsert (not possible with two separate better-sqlite3 connections), which is why the job payload is self-contained per the doc's risk note; added `GET /api/profile/jobs/:id` (404 across users, matching FiltersModule/TrackerService's per-user scoping style). `renderJobId` is now always a real id — jobs sit `pending` until the bot's own drain job (its P2 follow-up PR) lands. P3 (upload/parse intake), P4 (erasure) not yet started. |
| 2026-08-30 | sonnet | RESUME_PROFILE_STORE P3 (upload intake + parse handoff): `POST /api/profile/uploads` (multipart, reusing FilesModule's `FileInterceptor`/`memoryStorage` plumbing) whitelists `docx\|pdf\|txt\|md` via a multer `fileFilter` (rejects before buffering — 400) and caps at 10MB via `limits.fileSize` (Nest maps multer's `LIMIT_FILE_SIZE` to 413 automatically, confirmed in `@nestjs/platform-express`'s `transformException`); stores the upload as `users/{id}/uploads/{uuid}.{ext}` — the client's original filename is only ever used, `basename()`'d, as display metadata (with a sha256) in the new `profile_jobs` row's `result` column, never as part of the actual path, so a `../`-laden filename is inert by construction (added `UserPathsService.uploadsDir`, not part of `ensureUserDirs` — created lazily on first upload like `FilesService.saveUpload`'s sub-dirs). Throttled 10/hour per authenticated user via a new `UserThrottlerGuard` (keys `ThrottlerGuard.getTracker` off `req.user.id` instead of IP — `AuthController`'s existing per-IP throttle isn't right for an already-JWT-scoped route). Generalized `ProfileService`'s job-insert helper from `createRenderJob` to `createJob(userId, kind, payload, result?)` so PUT/restore's `render` jobs and upload's `parse` jobs share one code path. |
| 2026-08-30 | sonnet | RESUME_PROFILE_STORE P4 (erasure + admin), completing the work order: `AdminService.deleteUser` now calls a new `ProfileService.eraseUser` (which deletes `profiles`/`profile_revisions` via a new `ProfilesRepository.deleteAllForUser` transaction, plus `profile_jobs` via `TrackerService.db`) before the existing `rmSync` of `users/{id}/` — no separate uploads/ cleanup needed since that directory already lived under the same tree `rmSync` was already removing. Exported `ProfileService` from `ProfileModule` and imported it into `AdminModule` (no cycle: `ProfileModule` only depends on `TrackerModule`/`UsersModule`). e2e (in `profile.e2e-spec.ts`, using the seeded owner's admin token): gives a user a profile + an upload, deletes them via `DELETE /api/admin/users/:id`, asserts zero rows left in `profiles`/`profile_revisions`/`profile_jobs` and that `uploads/` is gone. |
| 2026-08-30 | sonnet | Adversarial audit of the merged P1-P4 (no code defects found in the checked logic — validation, path handling, DDL, and erasure all matched the work order and held up under attack). `test/fixtures/profile_contract_v1.json` re-verified byte-identical to the bot repo's `candidate/profile.example.json` at its current master (`5ea4fb3d`) via git-blob SHA-256, not just a working-tree diff (a CRLF-vs-LF artifact from how the comparison copy was made looked like drift at first). Closed two real e2e gaps in `profile.e2e-spec.ts`: no test proved `POST /api/profile/revisions/:rev/restore` rejects a revision number that belongs to another user (code was already scoped by `user_id` in `ProfilesRepository.getRevision`, but nothing exercised it), and no test proved the upload endpoint's 10/hour throttle actually rejects the 11th request (added as a dedicated user so the count doesn't depend on how many uploads earlier tests already spent). Fixed two stale, pre-existing (not from this work order) inaccuracies in this file's endpoint table: `POST /auth/login` returns `{ accessToken }` not `{ access_token }` (`auth.service.ts`), and the auth routes are throttled 30/min not 10/min (`AuthController`'s `@Throttle`). Flagged, not changed (needs a decision, touches the cross-repo contract): `ProfileService.uploadResume` stores upload metadata (original filename + sha256) in `profile_jobs.result` at job creation, but the shared contract defines `result` as the bot's output once a job is `done` — a client polling `GET /api/profile/jobs/:id` sees a non-empty `result` while `status` is still `pending`, and the metadata is overwritten (lost) once the bot's drain job writes its real parse output there. Not fixed here because both other columns are pinned by the cross-repo contract (`payload` must stay a bare relative path for the bot's future drain code; changing `result`'s shape needs sign-off since the site's work order consumes it too). |
| 2026-08-31 | sonnet | docs/PROFILE_PAGE_TABS.md T1 (preview job flow): `POST /api/profile/preview` (validates `track` against `^[a-z][a-z0-9_]*$` — "core" already satisfies it, not a separate exception — 400 otherwise; 409 when the caller has no stored profile; the job payload `{profile, track}` is built server-side from the `profiles` table, never accepted from the client; throttled 10/hour/user via the existing `UserThrottlerGuard`; no DDL change, `kind='preview'` reuses the free-text `profile_jobs.kind` column). `GET /api/profile/previews` lists `users/{id}/candidate/preview/<track>/<ts>/` newest-first (sorted by each run folder's mtime, not the timestamp string, since the API doesn't own that format), `[]` when the tree doesn't exist. `GET /api/profile/previews/:track/:ts/:file` serves one file, modeled on `GeneratedController`'s date/company/file pattern but plain-JWT (not the `?dt=` download-token flow — the T1 doc scopes this whole surface as "all JWT, user-scoped"). New shared helper `src/profile/profile-preview.ts` (`isValidTrack`, `isPathSafeComponent`, content-type table) used by both the job-insert path and the two read endpoints, since `track` is validated for both a queue payload and a URL path segment. Path safety is two-layered: `isPathSafeComponent` rejects `/`, `\`, `..`, or empty BEFORE any join (catches a `%2f`-decoded segment Express would otherwise hand back with an embedded slash), then `safeJoin` (`src/files/safe-path.ts`) re-checks the resolved path as a second line of defense — same discipline the bot's `_resolve_user_relative_path` applies on its side of the bus. New `UserPathsService.previewDir()`. 19 new e2e cases in a dedicated `test/profile-preview.e2e-spec.ts` (own temp DB/USERS_ROOT, mirroring `profile.e2e-spec.ts`'s setup rather than appending to that file, to avoid depending on its revision-number/throttle-bucket state): pending-job payload correctness, invalid-track 400 (`it.each` over uppercase/leading-digit/slash/dot-dot/empty/space), no-profile 409, throttle 429 on the 11th request, cross-user isolation on both the jobs-poll and previews endpoints (404, not another user's data), listing sort order (planted fixture folders with controlled `mtime` via `utimesSync`), and four traversal attempts against a file planted one level up from the preview tree (`candidate/candidate.yaml`) — none reach 200 or leak content. Full suites green: unit 30/30 (unchanged), e2e 47/47 (28 existing + 19 new). Note: `npm run lint` (`eslint --fix`) reformatted ~24 unrelated files across the repo when run un-scoped — per this file's own 2026-08-13 entry lint isn't a CI gate, and those reformats were reverted before this PR; linted only the touched files instead (`eslint --no-fix <files>`), 0 problems outside the new e2e spec, which carries the same `no-unsafe-*`-on-`any` pattern already present throughout `profile.e2e-spec.ts`/`filters.e2e-spec.ts`. T2 (uploads/files read endpoints, `lastRenderJob`) and T3 (`isOwner`) are separate PRs per the work order. |
