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
- `app.sqlite` — own DB, `users` table. NestJS owns schema.
- `tracker.db` — bot's DB, mounted via Docker volume. Bot owns schema;
  NestJS reads freely + writes only Sent/To Learn/Re-application.

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
# Auth (public, rate-limited: 10/min per IP)
POST /auth/register        { email, password } → { id, email }   (gated by REGISTRATION_ENABLED)
POST /auth/login           { email, password } → { access_token }
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

# Telegram (JWT required)
POST /api/telegram/link-code → { code, expiresAt }  (6-char, 10-min)
GET  /api/telegram/status    → { linked: boolean, chatId? }

# Admin (JWT required, role=admin)
GET    /api/admin/users
PATCH  /api/admin/users/:id  { disabled: boolean }
DELETE /api/admin/users/:id

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
