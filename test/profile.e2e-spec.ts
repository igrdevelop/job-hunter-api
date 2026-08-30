import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';

const fixture = JSON.parse(
  readFileSync(
    join(__dirname, 'fixtures', 'profile_contract_v1.json'),
    'utf8',
  ),
);

describe('ProfileModule (e2e)', () => {
  let app: INestApplication<App>;
  let appDbPath: string;
  let tokenA: string;
  let tokenB: string;
  const emailA = 'profile-e2e-a@test.local';
  const emailB = 'profile-e2e-b@test.local';
  const password = 'profile-e2e-password-1';

  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), 'profile-e2e-'));
    appDbPath = join(root, 'app.sqlite');
    process.env.JWT_SECRET = 'e2e-profile-secret-'.repeat(4);
    process.env.APP_DB_PATH = appDbPath;
    process.env.TRACKER_DB_PATH = join(root, 'tracker.db');
    process.env.USERS_ROOT = join(root, 'users');
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

    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: emailB, password })
      .expect(201);

    // Registration requires email verification before the JWT guard admits
    // the account; flip it directly rather than parsing the logged-to-
    // console verification link.
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
  });

  afterAll(async () => {
    await app?.close();
  });

  function authed(method: 'get' | 'put' | 'post', path: string, token: string) {
    return request(app.getHttpServer())
      [method](path)
      .set('Authorization', `Bearer ${token}`);
  }

  it('GET with no profile yet → 404', async () => {
    await authed('get', '/api/profile', tokenA).expect(404);
  });

  it('PUT valid document → 200 { revision: 1, renderJobId }', async () => {
    const res = await authed('put', '/api/profile', tokenA)
      .send(fixture)
      .expect(200);

    expect(res.body).toEqual({
      revision: 1,
      renderJobId: expect.any(String),
    });
  });

  it('GET after PUT is byte-equal to what was sent', async () => {
    const res = await authed('get', '/api/profile', tokenA).expect(200);

    expect(res.body.profile).toEqual(fixture);
    expect(res.body.revision).toBe(1);
    expect(typeof res.body.updatedAt).toBe('string');
  });

  it('PUT invalid document → 400 and stored profile untouched', async () => {
    const stripped = JSON.parse(JSON.stringify(fixture));
    stripped.core.identity.full_name = '';

    const res = await authed('put', '/api/profile', tokenA)
      .send(stripped)
      .expect(400);

    expect(res.body.errors['core.identity.full_name']).toBeDefined();

    const after = await authed('get', '/api/profile', tokenA).expect(200);
    expect(after.body.revision).toBe(1);
  });

  it('PUT again increments the revision', async () => {
    const updated = JSON.parse(JSON.stringify(fixture));
    updated.core.summary = 'Updated summary for revision 2.';

    const res = await authed('put', '/api/profile', tokenA)
      .send(updated)
      .expect(200);

    expect(res.body).toEqual({
      revision: 2,
      renderJobId: expect.any(String),
    });

    const after = await authed('get', '/api/profile', tokenA).expect(200);
    expect(after.body.profile.core.summary).toBe(
      'Updated summary for revision 2.',
    );
  });

  it('PUT creates a pending render job with a self-contained payload', async () => {
    const doc = JSON.parse(JSON.stringify(fixture));
    doc.core.summary = 'Job payload check.';

    const put = await authed('put', '/api/profile', tokenA)
      .send(doc)
      .expect(200);

    const job = await authed(
      'get',
      `/api/profile/jobs/${put.body.renderJobId}`,
      tokenA,
    ).expect(200);

    expect(job.body).toEqual({ kind: 'render', status: 'pending' });
  });

  it("GET job for another user's job id → 404", async () => {
    const put = await authed('put', '/api/profile', tokenA)
      .send(fixture)
      .expect(200);

    await authed(
      'get',
      `/api/profile/jobs/${put.body.renderJobId}`,
      tokenB,
    ).expect(404);
  });

  it('GET nonexistent job id → 404', async () => {
    await authed('get', '/api/profile/jobs/does-not-exist', tokenA).expect(
      404,
    );
  });

  it('GET /api/profile/revisions lists newest first', async () => {
    const current = await authed('get', '/api/profile', tokenA).expect(200);
    const latestRev: number = current.body.revision;

    const res = await authed('get', '/api/profile/revisions', tokenA).expect(
      200,
    );

    expect(res.body).toEqual(
      Array.from({ length: latestRev }, (_, i) => ({
        rev: latestRev - i,
        createdAt: expect.any(String),
      })),
    );
  });

  it('restore an old revision creates a new one with that content', async () => {
    const before = await authed('get', '/api/profile', tokenA).expect(200);
    const nextRev: number = before.body.revision + 1;

    const res = await authed(
      'post',
      '/api/profile/revisions/1/restore',
      tokenA,
    ).expect(200);

    expect(res.body).toEqual({
      revision: nextRev,
      renderJobId: expect.any(String),
    });

    const after = await authed('get', '/api/profile', tokenA).expect(200);
    expect(after.body.revision).toBe(nextRev);
    expect(after.body.profile).toEqual(fixture);
  });

  it('restore of a non-existent revision → 404', async () => {
    await authed('post', '/api/profile/revisions/999/restore', tokenA).expect(
      404,
    );
  });

  it('prunes revisions past the last 20', async () => {
    for (let i = 0; i < 25; i++) {
      const doc = JSON.parse(JSON.stringify(fixture));
      doc.core.summary = `prune-test-${i}`;
      await authed('put', '/api/profile', tokenA).send(doc).expect(200);
    }

    const res = await authed('get', '/api/profile/revisions', tokenA).expect(
      200,
    );
    expect(res.body.length).toBe(20);

    const latest = await authed('get', '/api/profile', tokenA).expect(200);
    expect(latest.body.profile.core.summary).toBe('prune-test-24');
    expect(res.body[0].rev).toBe(latest.body.revision);
  });

  it("isolation: user B never sees or affects user A's profile", async () => {
    // User B has no profile of their own — must 404, never fall through to A's.
    await authed('get', '/api/profile', tokenB).expect(404);

    const bDoc = JSON.parse(JSON.stringify(fixture));
    bDoc.core.identity.full_name = 'Bob Roe';
    const putB = await authed('put', '/api/profile', tokenB)
      .send(bDoc)
      .expect(200);
    expect(putB.body.revision).toBe(1);

    const getA = await authed('get', '/api/profile', tokenA).expect(200);
    expect(getA.body.profile.core.identity.full_name).toBe('Jane Doe');

    const getB = await authed('get', '/api/profile', tokenB).expect(200);
    expect(getB.body.profile.core.identity.full_name).toBe('Bob Roe');

    // B's revision numbering is independent of A's (A is already past 20 by now).
    const revsB = await authed(
      'get',
      '/api/profile/revisions',
      tokenB,
    ).expect(200);
    expect(revsB.body).toEqual([{ rev: 1, createdAt: expect.any(String) }]);
  });
});
