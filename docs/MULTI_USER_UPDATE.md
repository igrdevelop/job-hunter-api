# Multi-User Update — api repo work order

Self-contained work order for converting `job-hunter-api` to multi-tenant. Companion
files exist in the sibling repos (`../bot/docs/MULTI_USER_UPDATE.md`,
`../site/docs/MULTI_USER_UPDATE.md`) — each repo is worked on by its own agent.
**The "Shared contract" section below is duplicated in all three files and must stay
in sync. Do not change contract details unilaterally — flag mismatches to the user.**

## Goal

Full multi-tenant: open self-registration with email verification; every user gets
their own candidate source files, templates, generated documents (Applications/),
tracker rows, and settings. The bot side (Telegram binding, per-user pipeline) is
handled in the bot repo; this repo owns identity, per-user storage resolution, the
REST API, and the shared-table migrations.

## Shared contract (identical in all three repos)

### Storage layout (host: `/home/deploy/job-hunter/users/`, env `USERS_ROOT`)

```
users/{userId}/
  candidate/            # candidate.yaml, candidate_profile.md, base_cv_*.md, examples/
  Applications/         # generated docs, {YYYY-MM-DD}/{Company}[_N]/
  templates/            # resume/cover-letter templates + manifest.json
```

`userId` is the `users.id` TEXT primary key from app.sqlite (existing format).

### tracker.db shared-table DDL (bot mirrors these idempotently in `hunter/db.py`)

```sql
-- applications: add user scoping (backfill existing rows with the owner's id)
ALTER TABLE applications ADD COLUMN user_id TEXT NOT NULL DEFAULT '';
UPDATE applications SET user_id = '<ownerId>' WHERE user_id = '';
DROP INDEX IF EXISTS idx_url_norm;
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_url_norm
  ON applications(user_id, url_norm) WHERE url_norm != '';
CREATE INDEX IF NOT EXISTS idx_user_ats ON applications(user_id, ats_status);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id TEXT NOT NULL, key TEXT NOT NULL,
  value TEXT NOT NULL DEFAULT '', updated_at TEXT,
  PRIMARY KEY (user_id, key));

CREATE TABLE IF NOT EXISTS telegram_links (
  chat_id INTEGER PRIMARY KEY, user_id TEXT UNIQUE NOT NULL, linked_at TEXT);

CREATE TABLE IF NOT EXISTS telegram_link_codes (
  code TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at TEXT NOT NULL);
```

The API runs these migrations (it owns schema for shared tables); the bot's
`_ensure_columns` mirrors them so either process can start first.

### API surface consumed by the site (new/changed)

```
POST /auth/register {email,password}     # gated by REGISTRATION_ENABLED, sends verify mail
POST /auth/verify {token}                # public
POST /auth/resend {email}                # public
GET  /auth/me                            # → { id, email, role, emailVerified }
GET  /auth/download-token                # → { token } (5-min JWT, aud 'download')
GET/PUT /api/settings                    # per-user editable settings (whitelist schema)
GET  /api/settings/global                # admin-only, masked .env view (old behavior)
POST /api/telegram/link-code             # → { code, expiresAt }
GET  /api/telegram/status                # → { linked: boolean, chatId? }
GET/PATCH/DELETE /api/admin/users[...]   # admin role only
```

All file/generated/template stream endpoints additionally accept `?dt=<download-token>`.
JWT payload becomes `{ sub, email, role }`. Unverified users get 403 on `/api/*`.

### Per-user vs global settings (whitelist)

Per-user (stored in `user_settings`): `AUTO_APPLY`, `MAX_JOBS_PER_RUN`,
`APPLY_DELAY_SEC`, `CANDIDATE_TRACKS`, `CV_GDPR_CLAUSE`, `TELEGRAM_SEND_DOCS`,
source enable toggles, `hunting_enabled`.
Global (stay in bot .env, admin-only visibility): `TELEGRAM_BOT_TOKEN`, all
LLM/JUDGE/TRANSLATE API keys, schedule times, scraper infrastructure.
`GSHEETS_*` / `GDRIVE_*`: owner-only (forced off for other users).

## Current state in THIS repo (verified 2026-08-06)

- Auth in `src/auth/`: users table in app.sqlite (`user.db.ts`, better-sqlite3, WAL),
  JWT 7d, global `APP_GUARD` JwtAuthGuard, `@Public()` on register/login/health.
  `POST /auth/register` is currently public and unrestricted. Seeding from
  `SEED_USER_*` in `auth.service.ts onModuleInit` when table empty.
- `src/config/configuration.ts` defines process-wide paths: `app.dbPath`,
  `tracker.dbPath`, `files.path` (Applications/), `candidate.path`, `bot.envPath`.
- Each service resolves ONE global root in its constructor: `tracker.service.ts`
  (writes only `sent`/`to_learn`), `analytics.service.ts` (opens tracker.db a second
  time), `generated.service.ts`, `files.service.ts`, `templates.service.ts`
  (candidate/templates + flat manifest.json), `settings.service.ts` (dotenv.parse of
  bot .env, masked). `src/files/safe-path.ts` has `safeJoin` — reuse it.
- No ORM, no migration framework. Global prefix `api` excluding `auth/*`, `health`.
- **LIVE BUG:** `APP_DB_PATH` is not set in `docker-compose.prod.yml` and not on a
  volume → app.sqlite (users table) is lost on every container recreate and reseeded.
- **`.env` in this repo has a committed `JWT_SECRET`** — rotate it (new secret via
  GitHub Actions secret / VPS env, never committed).

## Work phases for this repo

### Phase A1 — prod integrity + auth foundations (do first, small)

1. `docker-compose.prod.yml`: set `APP_DB_PATH: /app/data/app/app.sqlite` and add
   volume `- /home/deploy/job-hunter-web/app-data:/app/data/app` (api-owned dir,
   NOT inside the bot's tree). Rotate `JWT_SECRET` out of the committed `.env`.
2. New `src/db/migrations.ts`: minimal versioned runner for app.sqlite
   (`schema_migrations(version INTEGER PRIMARY KEY)`), run before AuthService seeding.
   Migration 001:
   `users` + `role TEXT NOT NULL DEFAULT 'user'`, `email_verified INTEGER NOT NULL
   DEFAULT 0`, `disabled INTEGER NOT NULL DEFAULT 0`; existing rows →
   `role='admin', email_verified=1`.
3. `REGISTRATION_ENABLED` env (default false) — register returns 403 when off.
   JWT payload gains `role`; `jwt.strategy.ts` passes it through; new
   `roles.guard.ts` + `@Roles()` decorator. Login rejects `disabled=1`.
4. Download-token flow: `GET /auth/download-token` → 5-minute JWT with
   `aud: 'download'`; file/generated/template GET-stream endpoints accept
   `?dt=` query param (validated against that audience). (The site currently opens
   these URLs via `window.open` with no header — broken today.)

### Phase A2 — per-user storage (big)

1. `configuration.ts`: `usersRoot` (env `USERS_ROOT`, default `./data/users`)
   replaces `files.path` / `candidate.path`.
2. New `src/users/user-paths.service.ts`: `candidateDir(userId)`,
   `applicationsDir(userId)`, `templatesDir(userId)` via `safeJoin(usersRoot, ...)`;
   `ensureUserDirs(userId)` (called on registration; seeds empty dirs +
   `templates/manifest.json`).
3. Refactor `files/generated/templates` services: drop constructor root, take
   `userId` as first argument; controllers pass it via a new `@CurrentUser()`
   decorator.
4. `tracker.service.ts` / `analytics.service.ts`: every query gains
   `WHERE user_id = ?`. Add the tracker.db migration from the shared contract
   (idempotent, safe if the bot already applied it). Owner id for backfill: the
   single existing admin user's id at migration time.
5. `scripts/migrate-owner-data.sh` (run once on VPS, documented in the script
   header): move existing `candidate/`, `Applications/`, `candidate/templates/`
   into `users/{ownerId}/…`.
6. compose: replace `Applications`/`candidate` mounts with
   `- /home/deploy/job-hunter/users:/app/data/users` (rw), env `USERS_ROOT`.

### Phase A3 — registration, verification, admin (medium)

1. app.sqlite migration 002: `email_verification_tokens(token TEXT PRIMARY KEY,
   user_id TEXT, expires_at TEXT)`.
2. `src/mail/mail.service.ts` — nodemailer with `SMTP_HOST/PORT/USER/PASS/FROM`
   envs. Register: create user + `ensureUserDirs` + send link
   `https://job-hunter.igrflex.work/verify?token=…`. Public `POST /auth/verify`,
   `POST /auth/resend`. Non-verified → 403 on `/api/*` (extend the global guard).
3. Rate-limit `/auth/*` with `@nestjs/throttler`.
4. Admin module: `GET /api/admin/users`, `PATCH /api/admin/users/:id {disabled}`,
   `DELETE /api/admin/users/:id` (delete rows in both DBs + user dir), all
   `@Roles('admin')`.

### Phase A4 — per-user settings + telegram endpoints (medium)

1. Settings module rewrite: typed whitelist schema (see contract), `GET
   /api/settings` returns merged defaults+overrides for the current user,
   `PUT /api/settings` validates against the schema and upserts `user_settings`.
   Admin-only `GET /api/settings/global` keeps the masked .env view. Seed the
   owner's rows from their current .env values on first migration.
2. Telegram endpoints: `POST /api/telegram/link-code` (generate 6-char code,
   10-min expiry, write `telegram_link_codes`), `GET /api/telegram/status`
   (read `telegram_links`).

## Verification per phase

- A1: recreate container twice → login survives without reseed; register → 403;
  file downloads work end-to-end with `?dt=`.
- A2: owner sees identical Applications/files/templates/stats after data migration;
  `npm run test` green; manual smoke of every endpoint with the owner JWT.
- A3: second account registers → verifies → sees empty data, cannot access owner's;
  admin endpoints reject non-admin JWT.
- A4: settings round-trip (PUT then GET); link-code appears in tracker.db and
  expires.

## Coordination notes

- Deploy A2 together with the bot repo's mirror migration + `DEFAULT_USER_ID`
  change (bot work order, Phase B1) in one maintenance window.
- Keep `src/tracker/dto/` in sync with the site's `core/api/models.ts` (manual sync
  convention — site agent owns its side).
- Update `CLAUDE.md` in this repo (API contract section + work log) when phases land.
