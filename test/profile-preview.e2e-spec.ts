import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import Database from 'better-sqlite3';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';

const fixture = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'profile_contract_v1.json'), 'utf8'),
);

// docs/PROFILE_PAGE_TABS.md T1 — preview job flow.
describe('ProfileModule preview flow (e2e)', () => {
  let app: INestApplication<App>;
  let trackerDbPath: string;
  let usersRoot: string;
  let tokenA: string;
  let tokenB: string;
  let userIdA: string;
  const emailA = 'profile-preview-e2e-a@test.local';
  const emailB = 'profile-preview-e2e-b@test.local';
  const password = 'profile-preview-e2e-password-1';

  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), 'profile-preview-e2e-'));
    const appDbPath = join(root, 'app.sqlite');
    trackerDbPath = join(root, 'tracker.db');
    usersRoot = join(root, 'users');
    process.env.JWT_SECRET = 'e2e-profile-preview-secret-'.repeat(4);
    process.env.APP_DB_PATH = appDbPath;
    process.env.TRACKER_DB_PATH = trackerDbPath;
    process.env.USERS_ROOT = usersRoot;
    process.env.SEED_USER_EMAIL = emailA;
    process.env.SEED_USER_PASSWORD = password;
    process.env.REGISTRATION_ENABLED = 'true';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api', { exclude: ['auth/{*path}', 'health'] });
    await app.init();

    const loginA = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: emailA, password })
      .expect(201);
    tokenA = loginA.body.accessToken as string;

    const meA = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);
    userIdA = meA.body.id as string;

    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: emailB, password })
      .expect(201);

    const db = new Database(appDbPath);
    db.prepare('UPDATE users SET email_verified = 1 WHERE email = ?').run(
      emailB,
    );
    db.close();

    const loginB = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: emailB, password })
      .expect(201);
    tokenB = loginB.body.accessToken as string;

    await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${tokenB}`)
      .expect(200);

    // User A has a stored profile throughout this file; user B deliberately
    // never gets one, so it also covers the "no profile" 409 case.
    await request(app.getHttpServer())
      .put('/api/profile')
      .set('Authorization', `Bearer ${tokenA}`)
      .send(fixture)
      .expect(200);
  });

  afterAll(async () => {
    await app?.close();
  });

  function authed(
    method: 'get' | 'put' | 'post' | 'delete',
    path: string,
    token: string,
  ) {
    return request(app.getHttpServer())
      [method](path)
      .set('Authorization', `Bearer ${token}`);
  }

  interface ProfileJobRow {
    user_id: string;
    kind: string;
    payload: string;
    status: string;
  }

  function readJobRow(jobId: string): ProfileJobRow {
    const db = new Database(trackerDbPath, { readonly: true });
    try {
      return db
        .prepare(
          `SELECT user_id, kind, payload, status FROM profile_jobs WHERE id = ?`,
        )
        .get(jobId) as ProfileJobRow;
    } finally {
      db.close();
    }
  }

  /** Plant a fake bot-written preview folder directly on disk. */
  function plantPreview(
    userId: string,
    track: string,
    timestamp: string,
    files: Record<string, string | Buffer>,
    mtime?: Date,
  ): string {
    const dir = join(
      usersRoot,
      userId,
      'candidate',
      'preview',
      track,
      timestamp,
    );
    mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, name), content);
    }
    if (mtime) {
      utimesSync(dir, mtime, mtime);
    }
    return dir;
  }

  it('POST /api/profile/preview with no stored profile → 409', async () => {
    await authed('post', '/api/profile/preview', tokenB)
      .send({ track: 'core' })
      .expect(409);
  });

  it.each(['Angular', '123track', 'a/b', 'a..b', '', 'has space'])(
    'POST /api/profile/preview with an invalid track %p → 400',
    async (track) => {
      await authed('post', '/api/profile/preview', tokenA)
        .send({ track })
        .expect(400);
    },
  );

  it('POST /api/profile/preview with a missing track → 400', async () => {
    await authed('post', '/api/profile/preview', tokenA).send({}).expect(400);
  });

  it('POST /api/profile/preview accepts the literal "core"', async () => {
    const res = await authed('post', '/api/profile/preview', tokenA)
      .send({ track: 'core' })
      .expect(201);
    expect(res.body).toEqual({ jobId: expect.any(String) });
  });

  it("POST /api/profile/preview creates a pending job whose payload embeds the caller's own profile", async () => {
    const res = await authed('post', '/api/profile/preview', tokenA)
      .send({ track: 'angular' })
      .expect(201);

    const row = readJobRow(res.body.jobId);
    expect(row.user_id).toBe(userIdA);
    expect(row.kind).toBe('preview');
    expect(row.status).toBe('pending');

    const payload = JSON.parse(row.payload);
    expect(payload.track).toBe('angular');
    expect(payload.profile).toEqual(fixture);

    // The job sits pending until the bot's drain job lands — polling it
    // through the existing jobs endpoint must not assume completion.
    const job = await authed(
      'get',
      `/api/profile/jobs/${res.body.jobId}`,
      tokenA,
    ).expect(200);
    expect(job.body).toEqual({ kind: 'preview', status: 'pending' });
  });

  it("another user's token cannot poll a preview job's status → 404", async () => {
    const res = await authed('post', '/api/profile/preview', tokenA)
      .send({ track: 'core' })
      .expect(201);

    await authed('get', `/api/profile/jobs/${res.body.jobId}`, tokenB).expect(
      404,
    );
  });

  it('POST /api/profile/preview is throttled to 10/hour per user', async () => {
    // Dedicated user so the count is exact and independent of the requests
    // the tests above already spent from tokenA's bucket.
    const emailC = 'profile-preview-e2e-throttle@test.local';
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: emailC, password })
      .expect(201);

    const appDbPath = process.env.APP_DB_PATH!;
    const db = new Database(appDbPath);
    db.prepare('UPDATE users SET email_verified = 1 WHERE email = ?').run(
      emailC,
    );
    db.close();

    const loginC = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: emailC, password })
      .expect(201);
    const tokenC = loginC.body.accessToken as string;

    await authed('put', '/api/profile', tokenC).send(fixture).expect(200);

    for (let i = 0; i < 10; i++) {
      await authed('post', '/api/profile/preview', tokenC)
        .send({ track: 'core' })
        .expect(201);
    }

    await authed('post', '/api/profile/preview', tokenC)
      .send({ track: 'core' })
      .expect(429);
  });

  it('GET /api/profile/previews → [] for a user with no preview runs yet', async () => {
    const res = await authed('get', '/api/profile/previews', tokenB).expect(
      200,
    );
    expect(res.body).toEqual([]);
  });

  it('GET /api/profile/previews lists dated runs newest-first', async () => {
    const older = new Date('2026-01-01T00:00:00Z');
    const newer = new Date('2026-06-01T00:00:00Z');
    plantPreview(
      userIdA,
      'angular',
      '2026-01-01T00-00-00Z',
      { 'resume.pdf': 'pdf-bytes-old' },
      older,
    );
    plantPreview(
      userIdA,
      'react',
      '2026-06-01T00-00-00Z',
      { 'resume.pdf': 'pdf-bytes-new' },
      newer,
    );

    const res = await authed('get', '/api/profile/previews', tokenA).expect(
      200,
    );

    expect(res.body).toEqual([
      {
        track: 'react',
        timestamp: '2026-06-01T00-00-00Z',
        files: ['resume.pdf'],
      },
      {
        track: 'angular',
        timestamp: '2026-01-01T00-00-00Z',
        files: ['resume.pdf'],
      },
    ]);
  });

  it("user B's previews listing never includes user A's runs", async () => {
    const res = await authed('get', '/api/profile/previews', tokenB).expect(
      200,
    );
    expect(res.body).toEqual([]);
  });

  it('GET /api/profile/previews/:track/:ts/:file downloads the planted file', async () => {
    const res = await authed(
      'get',
      '/api/profile/previews/react/2026-06-01T00-00-00Z/resume.pdf',
      tokenA,
    ).expect(200);

    expect(res.headers['content-type']).toBe('application/pdf');
    expect(Buffer.from(res.body).toString('utf8')).toBe('pdf-bytes-new');
  });

  it('GET .../:file works with a ?dt= download token and no Authorization header', async () => {
    // window.open cannot carry a bearer header — the site opens preview files
    // with the download-token flow (DownloadAuthGuard), same as FilesController.
    const tok = await authed('get', '/api/auth/download-token', tokenA).expect(
      200,
    );
    const res = await request(app.getHttpServer())
      .get(
        `/api/profile/previews/react/2026-06-01T00-00-00Z/resume.pdf?dt=${encodeURIComponent(
          tok.body.token as string,
        )}`,
      )
      .expect(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(Buffer.from(res.body).toString('utf8')).toBe('pdf-bytes-new');
  });

  it("a ?dt= token still scopes to its own user — user B's dt cannot fetch A's file", async () => {
    const tok = await authed('get', '/api/auth/download-token', tokenB).expect(
      200,
    );
    await request(app.getHttpServer())
      .get(
        `/api/profile/previews/react/2026-06-01T00-00-00Z/resume.pdf?dt=${encodeURIComponent(
          tok.body.token as string,
        )}`,
      )
      .expect(404);
  });

  it('a garbage ?dt= token is rejected with 401', async () => {
    await request(app.getHttpServer())
      .get(
        '/api/profile/previews/react/2026-06-01T00-00-00Z/resume.pdf?dt=not-a-jwt',
      )
      .expect(401);
  });

  it('GET .../:file 404s for a file that does not exist', async () => {
    await authed(
      'get',
      '/api/profile/previews/react/2026-06-01T00-00-00Z/missing.pdf',
      tokenA,
    ).expect(404);
  });

  it("user B cannot download user A's preview file → 404", async () => {
    await authed(
      'get',
      '/api/profile/previews/react/2026-06-01T00-00-00Z/resume.pdf',
      tokenB,
    ).expect(404);
  });

  it('a file planted outside the preview tree is unreachable via traversal', async () => {
    // Plant a sensitive file one level up from preview/ — inside
    // candidate/ but outside candidate/preview/ — and confirm no crafted
    // set of path segments can reach it through the download endpoint.
    const candidateDir = join(usersRoot, userIdA, 'candidate');
    mkdirSync(candidateDir, { recursive: true });
    writeFileSync(join(candidateDir, 'candidate.yaml'), 'top: secret');

    const attempts: [string, string, string][] = [
      ['..', 'x', 'candidate.yaml'],
      ['angular', '..', 'candidate.yaml'],
      ['angular', '2026-01-01T00-00-00Z', '../candidate.yaml'],
      ['angular', '..%2f..', 'candidate.yaml'],
    ];

    for (const [track, ts, file] of attempts) {
      const res = await authed(
        'get',
        `/api/profile/previews/${track}/${ts}/${file}`,
        tokenA,
      );
      expect(res.status).not.toBe(200);
      expect(res.text ?? '').not.toContain('top: secret');
    }
  });
});
