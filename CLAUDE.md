# CLAUDE.md — Project Context for AI Agents

Single source of truth for any agent working on this repo. Read it fully before making
changes. Update it when something here changes.

---

## What This Is

**job-hunter-api** — NestJS backend for the Job Hunter web application.
Serves the Angular frontend (static files) + REST API from one process.
Reads the Python bot's `tracker.db` and serves files from `Applications/`.

- **Owner:** Ihar Petrasheuski — Senior Frontend Developer (Angular, 10+ yrs), Wrocław, PL.
  Learning NestJS with this project.
- **Live URL:** https://job-hunter.igrflex.work
- **Current state:** not yet created. Setup instructions in `docs/SETUP.md`,
  implementation plan in `docs/IMPLEMENTATION_PLAN.md`.

---

## Architecture

```
NestJS :3000
├── / (static)      → Angular dist/ (SPA, index.html fallback)
├── /auth/*          → AuthModule (register, login, JWT)
├── /api/applications/* → ApplicationsModule (tracker.db CRUD)
├── /api/files/*     → FilesModule (serve Applications/ folder)
├── /api/analytics/* → AnalyticsModule (funnel, cost, stats)
└── /health          → Health check
```

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
- **@nestjs/serve-static** — serve Angular dist
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

Docker container on VPS (178.105.131.107), exposed via Cloudflare Tunnel
as `job-hunter.igrflex.work`. Part of the bot's `docker-compose.yml`.

The Dockerfile is a multi-stage build:
1. Build Angular (from `job-hunter-site` repo) → `dist/browser/`
2. Build NestJS → `dist/`
3. Production image: NestJS + Angular dist as static files

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
GET    /api/applications/stats  → { total, applied, sent, failed, expired }
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

- **`job-hunter-site`** — Angular frontend (built into this container's static files)
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
