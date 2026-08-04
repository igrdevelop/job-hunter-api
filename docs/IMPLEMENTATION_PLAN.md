# Backend Implementation Plan — Job Hunter API

> NestJS backend for the Job Hunter web app.
> Serves Angular static files + REST API from one process.
>
> **This repo:** `job-hunter-api` — NestJS
> **Frontend repo:** `job-hunter-site` — Angular 22
> **Bot repo:** `job-hunter` — Python (unchanged, writes tracker.db + Applications/)
>
> **Domain:** `job-hunter.igrflex.work`
> **Deploy:** Docker on VPS (178.105.131.107) via Cloudflare Tunnel

---

## Architecture

```
NestJS :3000
├── Static files: Angular dist/ → all non-API routes → index.html
├── /auth/*         → AuthModule (JWT, login, register)
├── /api/applications/* → ApplicationsModule (read/write tracker.db)
├── /api/files/*    → FilesModule (serve Applications/ folder)
└── /api/analytics/* → AnalyticsModule (funnel, cost, stats)
```

Two SQLite databases:
1. **Own DB** (`app.sqlite`) — `users` table. NestJS owns schema + read/write.
2. **Bot's DB** (`tracker.db`) — `applications` table + others. Bot owns
   schema; NestJS reads + limited writes (Sent, To Learn, Re-application).

---

## Step A0: Project skeleton + static serving (1 day)

**Prereq:** Project created via `docs/SETUP.md`.

### A0.1 Config module

```typescript
// src/config/configuration.ts
export default () => ({
  jwt: { secret: process.env.JWT_SECRET },
  tracker: { dbPath: process.env.TRACKER_DB_PATH || './data/tracker.db' },
  files: { path: process.env.FILES_PATH || './data/Applications' },
  seed: {
    email: process.env.SEED_USER_EMAIL,
    password: process.env.SEED_USER_PASSWORD,
  },
});
```

```typescript
// app.module.ts
@Module({
  imports: [
    ConfigModule.forRoot({ load: [configuration], isGlobal: true }),
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'public'),
      exclude: ['/api/(.*)', '/auth/(.*)'],
    }),
    // ... other modules
  ],
})
export class AppModule {}
```

### A0.2 Health endpoint

```typescript
// src/health/health.controller.ts
@Controller('health')
export class HealthController {
  @Get()
  check() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }
}
```

### A0.3 SPA fallback

All routes that don't match `/api/*` or `/auth/*` serve `index.html`
(Angular router handles client-side routing):

```typescript
// main.ts
const app = await NestFactory.create(AppModule);
app.setGlobalPrefix('api', { exclude: ['auth/(.*)', 'health'] });

// After all routes are registered, fallback to SPA
app.use((req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/auth/')) {
    return next();
  }
  res.sendFile(join(__dirname, '..', 'public', 'index.html'));
});
```

### A0.4 Dockerfile (multi-stage)

```dockerfile
# Stage 1: Build Angular
FROM node:22-alpine AS angular-build
WORKDIR /app
COPY ../job-hunter-site/package*.json ./
RUN npm ci
COPY ../job-hunter-site/ ./
RUN npm run build
# Output: /app/dist/job-hunter-site/browser/

# Stage 2: Build NestJS
FROM node:22-alpine AS nest-build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
# Output: /app/dist/

# Stage 3: Production
FROM node:22-alpine
WORKDIR /app
COPY --from=nest-build /app/dist ./dist
COPY --from=nest-build /app/node_modules ./node_modules
COPY --from=angular-build /app/dist/job-hunter-site/browser ./public
EXPOSE 3000
CMD ["node", "dist/main.js"]
```

> **Note:** The Dockerfile references `../job-hunter-site`. In practice,
> either use a docker-compose build context that includes both repos,
> or copy the Angular dist as a build artifact (CI builds Angular first,
> then copies `dist/` into the API build). Decide at implementation time.

### A0.5 docker-compose addition

Add to the bot's `docker-compose.yml`:

```yaml
  job-hunter-api:
    build:
      context: ../job-hunter-api
    volumes:
      - ./tracker.db:/app/data/tracker.db
      - ./Applications:/app/data/Applications:ro
    env_file:
      - ./job-hunter-api.env
    depends_on:
      - job-hunter

  cloudflared:
    image: cloudflare/cloudflared:latest
    command: tunnel run
    environment:
      - TUNNEL_TOKEN=${CLOUDFLARE_TUNNEL_TOKEN}
    restart: unless-stopped
```

### A0.6 Cloudflare Tunnel setup

One-time, in the Cloudflare dashboard (igrflex@gmail.com):

1. **Zero Trust → Networks → Tunnels → Create a tunnel**
2. Name: `job-hunter-vps`
3. Copy the tunnel token → save as `CLOUDFLARE_TUNNEL_TOKEN` in `.env`
4. **Add public hostname:**
   - Subdomain: `job-hunter` / Domain: `igrflex.work`
   - Service: `http://job-hunter-api:3000`
5. Cloudflare auto-creates the DNS CNAME
6. Switch `job-hunter.igrflex.work` from Cloudflare Pages to tunnel:
   - Delete the custom domain from the old Pages project, OR
   - The tunnel CNAME will override the Pages record automatically

**Verify:** `curl https://job-hunter.igrflex.work/health`

**Deliverable:** Health endpoint live at `job-hunter.igrflex.work`, Angular
starter page served.

---

## Step A1: Auth module (1-2 days)

### A1.1 User entity + own SQLite DB

```typescript
// src/auth/entities/user.entity.ts
import Database from 'better-sqlite3';

// Schema (created on startup if not exists)
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )
`;
```

Using `better-sqlite3` directly (not TypeORM) for the users DB — simpler,
synchronous, and matches the pattern for reading the bot's tracker.db.

### A1.2 Auth service

```typescript
// src/auth/auth.service.ts
@Injectable()
export class AuthService {
  register(email: string, password: string): User
  login(email: string, password: string): { access_token: string }
  validateUser(email: string, password: string): User | null
  findById(id: string): User | null
}
```

- Passwords: bcrypt hash (12 rounds)
- JWT: `{ sub: user.id, email: user.email }`, expires in 7 days
- Seed user: on startup, create from `SEED_USER_EMAIL` / `SEED_USER_PASSWORD`
  if no users exist

### A1.3 Auth controller

```
POST /auth/register   { email, password }    → { id, email }
POST /auth/login      { email, password }    → { access_token }
GET  /auth/me         (JWT required)         → { id, email }
```

### A1.4 JWT guard

```typescript
// src/auth/guards/jwt.guard.ts
// Protects all /api/* routes
// /auth/* and /health are public
```

### A1.5 Validation

DTOs with class-validator:
```typescript
export class LoginDto {
  @IsEmail() email: string;
  @IsString() @MinLength(6) password: string;
}
```

**Deliverable:** Register, login, JWT-protected routes working.

---

## Step A2: Applications module — tracker read/write (2-3 days)

The core integration: NestJS reads the bot's tracker.db.

### A2.1 Tracker database service

```typescript
// src/tracker/tracker.service.ts
@Injectable()
export class TrackerService {
  private db: Database.Database;

  constructor(private config: ConfigService) {
    // Open bot's tracker.db in READ-WRITE mode (WAL)
    this.db = new Database(config.get('tracker.dbPath'));
    this.db.pragma('journal_mode = WAL');
  }

  // Read
  getApplications(params: QueryParams): PaginatedResult<Application>
  getApplicationById(id: string): Application | null
  getStats(): ApplicationStats
  getFunnel(days?: number): FunnelData

  // Write (only 3 fields, same as Google Sheets pull)
  updateSent(id: string, sent: string): void
  updateToLearn(id: string, toLearn: string): void
  updateReapplication(id: string, value: string): void
}
```

### A2.2 Query params

```typescript
interface QueryParams {
  page?: number;        // default 1
  limit?: number;       // default 50, max 200
  sort?: string;        // column name
  order?: 'asc' | 'desc';
  status?: string;      // filter: applied|sent|failed|expired|pending
  search?: string;      // company + title LIKE search
}
```

### A2.3 Application DTO (maps tracker.db columns)

```typescript
interface Application {
  id: string;           // 8-char hex
  date: string;
  company: string;
  title: string;        // "Job Title" column
  stack: string;
  ats_status: string;   // "ATS %" column
  url: string;
  folder: string;
  sent: string;
  reapplication: string;
  to_learn: string;
  cost_usd: number | null;
  ats_verdict: number | null;
}
```

### A2.4 Controller

```
GET    /api/applications          → paginated list
GET    /api/applications/stats    → { total, applied, sent, failed, expired, pending }
GET    /api/applications/funnel   → funnel data (?days=30)
GET    /api/applications/:id      → single row
PATCH  /api/applications/:id      → update sent | to_learn | reapplication
```

All routes JWT-protected.

### A2.5 Pagination response format

```json
{
  "data": [ ... ],
  "meta": {
    "page": 1,
    "limit": 50,
    "total": 450,
    "totalPages": 9
  }
}
```

**Deliverable:** Full tracker data available as paginated JSON. Editable
fields updatable via PATCH.

---

## Step A3: Files module — serve Applications/ (1-2 days)

### A3.1 Files controller

```typescript
// src/files/files.controller.ts
@Controller('api/files')
export class FilesController {
  // List date folders
  @Get()
  listDates(): FolderInfo[]

  // List company folders for a date
  @Get(':date')
  listCompanies(@Param('date') date: string): FolderInfo[]

  // List files in a company folder
  @Get(':date/:company')
  listFiles(@Param('date') date: string, @Param('company') company: string): FileInfo[]

  // Download / stream a file
  @Get(':date/:company/:file')
  getFile(...): StreamableFile
}
```

### A3.2 Response types

```typescript
interface FolderInfo {
  name: string;
  itemCount: number;   // number of files or subfolders
  modified: string;    // ISO date
}

interface FileInfo {
  name: string;
  size: number;        // bytes
  type: string;        // "pdf" | "docx" | "txt" | "json" | "other"
  modified: string;
}
```

### A3.3 Security

- **Path traversal:** sanitize all params — no `..`, no absolute paths,
  no null bytes. Use `path.resolve()` + check it starts with `FILES_PATH`.
- **Hidden files:** skip files starting with `.`
- **Shadow folders:** include shadow subfolders (dual-apply comparisons) —
  they're just subdirectories within company folders.

### A3.4 Content types

| Extension | Content-Type | Disposition |
|-----------|-------------|-------------|
| .pdf | application/pdf | inline (browser renders) |
| .docx | application/vnd.openxmlformats... | attachment (download) |
| .txt | text/plain; charset=utf-8 | inline |
| .json | application/json | inline |
| other | application/octet-stream | attachment |

**Deliverable:** Browser can list and download any file from Applications/.

---

## Step A4: Analytics module (1 day)

### A4.1 Analytics service

Replicates `hunter/funnel.py` logic in SQL:

```typescript
@Injectable()
export class AnalyticsService {
  // Funnel: tracked → generated → sent → confirmed → answered
  getFunnel(days?: number): FunnelData

  // Per-source breakdown (source inferred from URL domain)
  getPerSource(days?: number): SourceStats[]

  // Cost summary
  getCostSummary(days?: number): CostSummary

  // Timeline (applications per day)
  getTimeline(days: number): TimelinePoint[]
}
```

### A4.2 Endpoints

```
GET /api/analytics/funnel?days=30
GET /api/analytics/sources?days=30
GET /api/analytics/cost?days=30
GET /api/analytics/timeline?days=90
```

### A4.3 Source inference

The bot's tracker.db doesn't store a `source` column. Infer from URL:
```typescript
function inferSource(url: string): string {
  const host = new URL(url).hostname;
  if (host.includes('justjoin')) return 'JustJoin.it';
  if (host.includes('nofluffjobs')) return 'NoFluffJobs';
  if (host.includes('linkedin')) return 'LinkedIn';
  // ... etc (same logic as hunter/funnel.py)
  return host; // fallback: raw domain
}
```

**Deliverable:** All analytics data available as JSON.

---

## Summary

| Step | Days | Deliverable |
|------|------|-------------|
| A0: Skeleton + tunnel | 1-2 | NestJS + Angular served via tunnel |
| A1: Auth | 1-2 | Login, register, JWT |
| A2: Applications | 2-3 | Tracker CRUD API |
| A3: Files | 1-2 | File listing + download |
| A4: Analytics | 1 | Funnel, cost, timeline |
| **Total** | **6-10** | **Full backend API** |

---

## Module structure (final)

```
src/
├── main.ts                    # Bootstrap + SPA fallback
├── app.module.ts              # Root module
├── config/
│   └── configuration.ts       # Env vars
├── auth/
│   ├── auth.module.ts
│   ├── auth.controller.ts
│   ├── auth.service.ts
│   ├── guards/
│   │   └── jwt.guard.ts
│   ├── strategies/
│   │   └── jwt.strategy.ts
│   ├── dto/
│   │   ├── login.dto.ts
│   │   └── register.dto.ts
│   └── user.db.ts             # Own SQLite (users table)
├── tracker/
│   ├── tracker.module.ts
│   ├── tracker.service.ts     # Reads/writes bot's tracker.db
│   └── dto/
│       ├── application.dto.ts
│       ├── query.dto.ts
│       └── update.dto.ts
├── applications/
│   ├── applications.module.ts
│   └── applications.controller.ts
├── files/
│   ├── files.module.ts
│   └── files.controller.ts
├── analytics/
│   ├── analytics.module.ts
│   ├── analytics.controller.ts
│   └── analytics.service.ts
└── health/
    └── health.controller.ts
```

---

## Testing

```bash
npm run test              # unit tests
npm run test:e2e          # e2e (with a test tracker.db fixture)
```

For integration testing, copy a sample `tracker.db` into `test/fixtures/`
(the bot repo has one at `tracker.db` in the root — 14 rows, enough for
testing queries). Same for a sample `Applications/` folder structure.

---

## What to decide at implementation time

1. **TypeORM vs raw better-sqlite3** for the users DB — TypeORM adds
   complexity; for one table, raw SQL is simpler and faster
2. **Dockerfile build strategy** for Angular — git submodule, CI artifact
   copy, or monorepo build context
3. **Rate limiting** on auth endpoints — `@nestjs/throttler` (recommended)
