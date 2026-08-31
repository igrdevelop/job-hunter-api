import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';

const fixture = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'profile_contract_v1.json'), 'utf8'),
);

// docs/PROFILE_PAGE_TABS.md T2 — uploads/files tab read endpoints +
// GET /api/profile's lastRenderJob. Own file (own temp DB/USERS_ROOT), same
// discipline as profile-preview.e2e-spec.ts, so this doesn't depend on
// profile.e2e-spec.ts's revision/throttle-bucket state.
describe('ProfileModule tab read endpoints (e2e)', () => {
  let app: INestApplication<App>;
  let appDbPath: string;
  let trackerDbPath: string;
  let usersRoot: string;
  let tokenA: string;
  let tokenB: string;
  let userIdA: string;
  const emailA = 'profile-tabs-e2e-a@test.local';
  const emailB = 'profile-tabs-e2e-b@test.local';
  const password = 'profile-tabs-e2e-password-1';

  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), 'profile-tabs-e2e-'));
    appDbPath = join(root, 'app.sqlite');
    trackerDbPath = join(root, 'tracker.db');
    usersRoot = join(root, 'users');
    process.env.JWT_SECRET = 'e2e-profile-tabs-secret-'.repeat(4);
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

  function candidateDir(userId: string): string {
    return join(usersRoot, userId, 'candidate');
  }

  function plantCandidateFile(
    userId: string,
    name: string,
    content: string,
  ): void {
    const dir = candidateDir(userId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), content);
  }

  interface ProfileJobRow {
    id: string;
    user_id: string;
    kind: string;
    payload: string;
    status: string;
    result: string;
    created_at: string;
    updated_at: string | null;
  }

  function readJobRow(jobId: string): ProfileJobRow {
    const db = new Database(trackerDbPath, { readonly: true });
    try {
      return db
        .prepare(`SELECT * FROM profile_jobs WHERE id = ?`)
        .get(jobId) as ProfileJobRow;
    } finally {
      db.close();
    }
  }

  /** Simulate the bot's drain job finishing a parse job in place. */
  function markJobDone(jobId: string, result: string): void {
    const db = new Database(trackerDbPath);
    db.prepare(
      `UPDATE profile_jobs SET status = 'done', result = ?, updated_at = ? WHERE id = ?`,
    ).run(result, new Date().toISOString(), jobId);
    db.close();
  }

  // ---------------------------------------------------------------------
  // GET /api/profile/files + GET /api/profile/files/:name
  // ---------------------------------------------------------------------

  describe('GET /api/profile/files', () => {
    it('→ [] (not an error) for a never-rendered user', async () => {
      const res = await authed('get', '/api/profile/files', tokenB).expect(200);
      expect(res.body).toEqual([]);
    });

    it('lists only whitelisted rendered files, sorted by name', async () => {
      plantCandidateFile(userIdA, 'candidate.yaml', 'identity: {}');
      plantCandidateFile(userIdA, 'candidate_profile.md', '# Profile');
      plantCandidateFile(userIdA, 'base_cv_angular.md', '# Angular CV');
      plantCandidateFile(userIdA, 'base_cv_react.md', '# React CV');
      plantCandidateFile(userIdA, 'generation_rules.local.md', 'notes');
      plantCandidateFile(userIdA, 'profile.json', '{}');
      // Off-list files that must never appear in the listing.
      plantCandidateFile(userIdA, 'secret.txt', 'nope');
      plantCandidateFile(userIdA, '.env', 'TOKEN=x');
      mkdirSync(join(candidateDir(userIdA), 'preview'), { recursive: true });

      const res = await authed('get', '/api/profile/files', tokenA).expect(200);

      const names = (res.body as { name: string }[]).map((f) => f.name);
      expect(names).toEqual([
        'base_cv_angular.md',
        'base_cv_react.md',
        'candidate.yaml',
        'candidate_profile.md',
        'generation_rules.local.md',
        'profile.json',
      ]);
      for (const entry of res.body) {
        expect(typeof entry.size).toBe('number');
        expect(typeof entry.modifiedAt).toBe('string');
      }
    });

    it("user B's listing never includes user A's files", async () => {
      const res = await authed('get', '/api/profile/files', tokenB).expect(200);
      expect(res.body).toEqual([]);
    });
  });

  describe('GET /api/profile/files/:name', () => {
    it('serves a whitelisted file with the right content + content-type', async () => {
      const res = await authed(
        'get',
        '/api/profile/files/candidate.yaml',
        tokenA,
      ).expect(200);
      expect(res.text).toBe('identity: {}');
      expect(res.headers['content-type']).toContain('text/yaml');
    });

    it('serves profile.json as application/json', async () => {
      const res = await authed(
        'get',
        '/api/profile/files/profile.json',
        tokenA,
      ).expect(200);
      expect(res.headers['content-type']).toContain('application/json');
    });

    it('serves a base_cv_<slug>.md file as markdown', async () => {
      const res = await authed(
        'get',
        '/api/profile/files/base_cv_react.md',
        tokenA,
      ).expect(200);
      expect(res.text).toBe('# React CV');
      expect(res.headers['content-type']).toContain('text/markdown');
    });

    it.each([
      'secret.txt',
      '.env',
      '..',
      '..%2f..%2fapp.sqlite',
      'base_cv_React.md',
      'base_cv_.md',
      'candidate.yml',
      'preview',
    ])('an off-list or malformed name %p → 404', async (name) => {
      await authed('get', `/api/profile/files/${name}`, tokenA).expect(404);
    });

    it('a whitelisted name that does not exist on disk → 404', async () => {
      await authed(
        'get',
        '/api/profile/files/generation_rules.local.md',
        tokenB,
      ).expect(404);
    });

    it("user B cannot read user A's file even by exact whitelisted name → 404", async () => {
      await authed('get', '/api/profile/files/candidate.yaml', tokenB).expect(
        404,
      );
    });

    it('there is no write access to these paths', async () => {
      // Confirms the whitelist really is read-only-by-construction — no
      // PUT/DELETE route is registered under /api/profile/files at all.
      await request(app.getHttpServer())
        .put('/api/profile/files/candidate.yaml')
        .set('Authorization', `Bearer ${tokenA}`)
        .send('hacked')
        .expect(404);
      await request(app.getHttpServer())
        .delete('/api/profile/files/candidate.yaml')
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(404);
    });
  });

  // ---------------------------------------------------------------------
  // GET /api/profile/uploads
  // ---------------------------------------------------------------------

  describe('GET /api/profile/uploads', () => {
    it('→ [] for a user with no uploads', async () => {
      const res = await authed('get', '/api/profile/uploads', tokenB).expect(
        200,
      );
      expect(res.body).toEqual([]);
    });

    it('lists an upload still pending with its metadata intact', async () => {
      const upload = await authed('post', '/api/profile/uploads', tokenA)
        .attach('file', Buffer.from('resume text'), 'my resume.txt')
        .expect(201);
      const jobId = upload.body.jobId as string;
      const jobRow = readJobRow(jobId);

      const res = await authed('get', '/api/profile/uploads', tokenA).expect(
        200,
      );
      const item = (res.body as any[]).find((u) => u.jobId === jobId);
      expect(item).toBeDefined();
      expect(item.filename).toBe('my resume.txt');
      expect(typeof item.sha256).toBe('string');
      expect(item.sha256).toBe(
        createHash('sha256').update('resume text').digest('hex'),
      );
      expect(item.jobStatus).toBe('pending');
      expect(item.uploadedAt).toBe(jobRow.created_at);
      // `id` is the stored upload uuid, distinct from `jobId`.
      expect(item.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(item.id).not.toBe(item.jobId);
    });

    it('once the bot overwrites result, filename is unrecoverable but sha256 is recomputed from disk', async () => {
      const upload = await authed('post', '/api/profile/uploads', tokenA)
        .attach('file', Buffer.from('another resume'), 'resume2.pdf')
        .expect(201);
      const jobId = upload.body.jobId as string;

      // Simulate the bot's drain job: it overwrites `result` with the real
      // parse output (a draft profile JSON), not upload metadata.
      markJobDone(jobId, JSON.stringify({ core: {}, leftovers: [] }));

      const res = await authed('get', '/api/profile/uploads', tokenA).expect(
        200,
      );
      const item = (res.body as any[]).find((u) => u.jobId === jobId);
      expect(item).toBeDefined();
      expect(item.jobStatus).toBe('done');
      expect(item.filename).toBeNull();
      expect(item.sha256).toBe(
        createHash('sha256').update('another resume').digest('hex'),
      );
    });

    it("user B's uploads listing never includes user A's uploads", async () => {
      const res = await authed('get', '/api/profile/uploads', tokenB).expect(
        200,
      );
      expect(res.body).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------
  // GET /api/profile → lastRenderJob
  // ---------------------------------------------------------------------

  describe("GET /api/profile's lastRenderJob", () => {
    it('is null before any PUT', async () => {
      // Dedicated user, never PUT before this point in the file.
      const emailC = 'profile-tabs-e2e-c@test.local';
      await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email: emailC, password })
        .expect(201);
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

      // No profile yet at all → 404, lastRenderJob is moot.
      await authed('get', '/api/profile', tokenC).expect(404);

      await authed('put', '/api/profile', tokenC).send(fixture).expect(200);
      const res = await authed('get', '/api/profile', tokenC).expect(200);
      expect(res.body.lastRenderJob).toEqual({
        id: expect.any(String),
        status: 'pending',
        updatedAt: expect.any(String),
      });
    });

    it('reflects the most recent render job, not a parse/preview job', async () => {
      const put1 = await authed('put', '/api/profile', tokenB)
        .send(fixture)
        .expect(200);
      const firstJobId = put1.body.renderJobId as string;

      // A parse (upload) job in between must not be picked up as the
      // "render" job.
      await authed('post', '/api/profile/uploads', tokenB)
        .attach('file', Buffer.from('resume'), 'resume.txt')
        .expect(201);

      const put2 = await authed('put', '/api/profile', tokenB)
        .send(fixture)
        .expect(200);
      const secondJobId = put2.body.renderJobId as string;
      expect(secondJobId).not.toBe(firstJobId);

      markJobDone(secondJobId, JSON.stringify(['candidate.yaml']));

      const res = await authed('get', '/api/profile', tokenB).expect(200);
      expect(res.body.lastRenderJob.id).toBe(secondJobId);
      expect(res.body.lastRenderJob.status).toBe('done');
    });
  });
});
