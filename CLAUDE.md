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
│     ├── /api/files/*     → FilesModule (serve Applications/ folder)
│     ├── /api/analytics/* → AnalyticsModule (funnel, cost, stats)
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
- `Applications/` — read-only (bot writes generated CVs, NestJS serves them)

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
| `TRACKER_DB_PATH` | no | Path to bot's tracker.db (default: `./data/tracker.db`) |
| `FILES_PATH` | no | Path to bot's Applications/ (default: `./data/Applications`) |
| `SEED_USER_EMAIL` | no | Owner email, seeded on first start |
| `SEED_USER_PASSWORD` | no | Owner password, seeded on first start |

---

## API endpoints

```
# Auth (public)
POST /auth/register        { email, password } → { id, email }
POST /auth/login           { email, password } → { access_token }
GET  /auth/me              (JWT) → { id, email }

# Applications (JWT required)
GET    /api/applications        ?page=&limit=&sort=&order=&status=&search=
GET    /api/applications/stats  → { total, applied, sent, failed, expired, pending }
GET    /api/applications/funnel ?days=30
GET    /api/applications/:id
PATCH  /api/applications/:id    { sent?, to_learn?, reapplication? }

# Files (JWT required)
GET /api/files                        → date folders
GET /api/files/:date                  → company folders
GET /api/files/:date/:company         → file list
GET /api/files/:date/:company/:file   → download/stream

# Analytics (JWT required)
GET /api/analytics/funnel?days=30
GET /api/analytics/sources?days=30
GET /api/analytics/cost?days=30
GET /api/analytics/timeline?days=90

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
