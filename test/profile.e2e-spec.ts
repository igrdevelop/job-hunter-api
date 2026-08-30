import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { MAX_UPLOAD_BYTES } from '../src/profile/profile-upload';

const fixture = JSON.parse(
  readFileSync(
    join(__dirname, 'fixtures', 'profile_contract_v1.json'),
    'utf8',
  ),
);

describe('ProfileModule (e2e)', () => {
  let app: INestApplication<App>;
  let appDbPath: string;
  let trackerDbPath: string;
  let usersRoot: string;
  let tokenA: string;
  let tokenB: string;
  let userIdA: string;
  let userIdB: string;
  const emailA = 'profile-e2e-a@test.local';
  const emailB = 'profile-e2e-b@test.local';
  const password = 'profile-e2e-password-1';

  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), 'profile-e2e-'));
    appDbPath = join(root, 'app.sqlite');
    trackerDbPath = join(root, 'tracker.db');
    usersRoot = join(root, 'users');
    process.env.JWT_SECRET = 'e2e-profile-secret-'.repeat(4);
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

    const meB = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${tokenB}`)
      .expect(200);
    userIdB = meB.body.id as string;
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
    result: string;
  }

  function readJobRow(jobId: string): ProfileJobRow {
    const db = new Database(trackerDbPath, { readonly: true });
    try {
      return db
        .prepare(
          `SELECT user_id, kind, payload, status, result FROM profile_jobs WHERE id = ?`,
        )
        .get(jobId) as ProfileJobRow;
    } finally {
      db.close();
    }
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

  it("isolation: user B cannot restore user A's revision by number", async () => {
    // A has been PUT dozens of times by this point (pruning test above) and
    // is far ahead of B's own revision count — pick a rev number that
    // exists for A but not for B, and confirm B gets 404, never A's content,
    // and B's own state is left untouched.
    const aState = await authed('get', '/api/profile', tokenA).expect(200);
    const aRev: number = aState.body.revision;

    const bBefore = await authed('get', '/api/profile', tokenB).expect(200);
    expect(aRev).toBeGreaterThan(bBefore.body.revision);

    await authed(
      'post',
      `/api/profile/revisions/${aRev}/restore`,
      tokenB,
    ).expect(404);

    const bAfter = await authed('get', '/api/profile', tokenB).expect(200);
    expect(bAfter.body).toEqual(bBefore.body);
  });

  it('POST /api/profile/uploads with a valid file → 201 with a self-contained relative payload', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/profile/uploads')
      .set('Authorization', `Bearer ${tokenA}`)
      .attach('file', Buffer.from('resume text'), 'my resume.txt')
      .expect(201);

    expect(res.body).toEqual({ jobId: expect.any(String) });

    const row = readJobRow(res.body.jobId);
    expect(row.user_id).toBe(userIdA);
    expect(row.kind).toBe('parse');
    expect(row.status).toBe('pending');
    expect(row.payload).toMatch(/^uploads\/[0-9a-f-]{36}\.txt$/);

    const metadata = JSON.parse(row.result);
    expect(metadata.filename).toBe('my resume.txt');
    expect(typeof metadata.sha256).toBe('string');

    expect(existsSync(join(usersRoot, userIdA, row.payload))).toBe(true);
  });

  it('POST /api/profile/uploads with an unsupported extension → 400', async () => {
    await request(app.getHttpServer())
      .post('/api/profile/uploads')
      .set('Authorization', `Bearer ${tokenA}`)
      .attach('file', Buffer.from('not a resume'), 'resume.exe')
      .expect(400);
  });

  it('POST /api/profile/uploads over the size limit → 413', async () => {
    const big = Buffer.alloc(MAX_UPLOAD_BYTES + 1024, 'a');
    await request(app.getHttpServer())
      .post('/api/profile/uploads')
      .set('Authorization', `Bearer ${tokenA}`)
      .attach('file', big, 'big.pdf')
      .expect(413);
  });

  it('path traversal in the uploaded filename is inert', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/profile/uploads')
      .set('Authorization', `Bearer ${tokenA}`)
      .attach('file', Buffer.from('resume text'), '../../etc/passwd.pdf')
      .expect(201);

    const row = readJobRow(res.body.jobId);
    // Stored name is always {uuid}.{ext} — the traversal never reaches the
    // filesystem path, and only survives, basename'd, as display metadata.
    expect(row.payload).toMatch(/^uploads\/[0-9a-f-]{36}\.pdf$/);
    expect(JSON.parse(row.result).filename).toBe('passwd.pdf');
    expect(existsSync(join(usersRoot, userIdA, row.payload))).toBe(true);
  });

  it('resume uploads are throttled to 10/hour per user', async () => {
    // A dedicated user, never touched by other upload tests, so the count
    // below is exact instead of depending on how many uploads earlier tests
    // already spent from tokenA's/tokenB's buckets.
    const emailC = 'profile-e2e-throttle@test.local';
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

    for (let i = 0; i < 10; i++) {
      await request(app.getHttpServer())
        .post('/api/profile/uploads')
        .set('Authorization', `Bearer ${tokenC}`)
        .attach('file', Buffer.from(`resume ${i}`), `resume-${i}.txt`)
        .expect(201);
    }

    await request(app.getHttpServer())
      .post('/api/profile/uploads')
      .set('Authorization', `Bearer ${tokenC}`)
      .attach('file', Buffer.from('one too many'), 'resume-11.txt')
      .expect(429);
  });

  it('DELETE /api/admin/users/:id erases all profile-store data for that user', async () => {
    // Give user B a profile and an upload to erase.
    const bDoc = JSON.parse(JSON.stringify(fixture));
    bDoc.core.identity.full_name = 'Erase Me';
    await authed('put', '/api/profile', tokenB).send(bDoc).expect(200);

    await request(app.getHttpServer())
      .post('/api/profile/uploads')
      .set('Authorization', `Bearer ${tokenB}`)
      .attach('file', Buffer.from('resume text'), 'erase-me.pdf')
      .expect(201);

    const uploadsDir = join(usersRoot, userIdB, 'uploads');
    expect(existsSync(uploadsDir)).toBe(true);

    // tokenA belongs to the seeded owner (role=admin).
    await authed('delete', `/api/admin/users/${userIdB}`, tokenA).expect(200);

    const appDb = new Database(appDbPath, { readonly: true });
    const profileRow = appDb
      .prepare('SELECT 1 FROM profiles WHERE user_id = ?')
      .get(userIdB);
    const revisionRow = appDb
      .prepare('SELECT 1 FROM profile_revisions WHERE user_id = ?')
      .get(userIdB);
    appDb.close();
    expect(profileRow).toBeUndefined();
    expect(revisionRow).toBeUndefined();

    const trackerDb = new Database(trackerDbPath, { readonly: true });
    const jobRow = trackerDb
      .prepare('SELECT 1 FROM profile_jobs WHERE user_id = ?')
      .get(userIdB);
    trackerDb.close();
    expect(jobRow).toBeUndefined();

    expect(existsSync(uploadsDir)).toBe(false);
  });
});
