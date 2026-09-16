import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';

// Token hardening: download tokens are not bearer tokens, and every token is
// re-checked against the current users row (exists, not disabled, role).
describe('Auth token hardening (e2e)', () => {
  let app: INestApplication<App>;
  let appDbPath: string;
  let usersRoot: string;
  let adminToken: string;
  const adminEmail = 'auth-hardening-e2e-admin@test.local';
  const password = 'auth-hardening-e2e-password-1';
  const fileContent = 'auth-hardening-note';

  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), 'auth-hardening-e2e-'));
    appDbPath = join(root, 'app.sqlite');
    usersRoot = join(root, 'users');
    process.env.JWT_SECRET = 'e2e-auth-hardening-secret-'.repeat(4);
    process.env.APP_DB_PATH = appDbPath;
    process.env.TRACKER_DB_PATH = join(root, 'tracker.db');
    process.env.USERS_ROOT = usersRoot;
    process.env.SEED_USER_EMAIL = adminEmail;
    process.env.SEED_USER_PASSWORD = password;
    process.env.REGISTRATION_ENABLED = 'true';
    delete process.env.OWNER_USER_ID;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api', { exclude: ['auth/{*path}', 'health'] });
    await app.init();

    adminToken = await login(adminEmail);
  });

  afterAll(async () => {
    await app?.close();
  });

  function server() {
    return request(app.getHttpServer());
  }

  function withDb<T>(fn: (db: Database.Database) => T): T {
    const db = new Database(appDbPath);
    try {
      return fn(db);
    } finally {
      db.close();
    }
  }

  async function login(email: string): Promise<string> {
    const res = await server()
      .post('/auth/login')
      .send({ email, password })
      .expect(201);
    return (res.body as { accessToken: string }).accessToken;
  }

  /** Registers a user, optionally marks them verified, logs in, plants a file. */
  async function createUser(
    email: string,
    opts: { verified?: boolean } = { verified: true },
  ): Promise<{ id: string; token: string }> {
    const reg = await server()
      .post('/auth/register')
      .send({ email, password })
      .expect(201);
    const { id } = reg.body as { id: string };
    if (opts.verified) {
      withDb((db) =>
        db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(id),
      );
    }
    const token = await login(email);
    const candidateDir = join(usersRoot, id, 'candidate');
    mkdirSync(candidateDir, { recursive: true });
    writeFileSync(join(candidateDir, 'note.txt'), fileContent);
    return { id, token };
  }

  async function downloadToken(accessToken: string): Promise<string> {
    const res = await server()
      .get('/auth/download-token')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    return (res.body as { token: string }).token;
  }

  function getWithDt(path: string, dt: string) {
    return server().get(`${path}?dt=${encodeURIComponent(dt)}`);
  }

  function getWithBearer(path: string, token: string) {
    return server().get(path).set('Authorization', `Bearer ${token}`);
  }

  describe('download tokens', () => {
    let user: { id: string; token: string };
    let dt: string;

    beforeAll(async () => {
      user = await createUser('auth-hardening-e2e-dt@test.local');
      dt = await downloadToken(user.token);
    });

    it('the access token itself works as a bearer token (control)', async () => {
      await getWithBearer('/api/filters', user.token).expect(200);
    });

    it('a dt token used as Bearer on /api/applications → 401', async () => {
      await getWithBearer('/api/applications', dt).expect(401);
    });

    it('a dt token used as Bearer on /api/filters → 401', async () => {
      await getWithBearer('/api/filters', dt).expect(401);
    });

    it("an admin's dt token used as Bearer on /api/admin/users → 401", async () => {
      const adminDt = await downloadToken(adminToken);
      await getWithBearer('/api/admin/users', adminDt).expect(401);
    });

    it('a dt token used as Bearer on a file route → 401', async () => {
      await getWithBearer('/api/files/note.txt', dt).expect(401);
    });

    it('a dt token still works via ?dt= on a file route → 200', async () => {
      const res = await getWithDt('/api/files/note.txt', dt).expect(200);
      expect(res.text).toBe(fileContent);
    });

    it('an access token passed as ?dt= is still rejected → 401', async () => {
      await getWithDt('/api/files/note.txt', user.token).expect(401);
    });
  });

  describe('disabled users', () => {
    it("a disabled user's pre-existing tokens → 401 on /api/* and on ?dt= downloads", async () => {
      const user = await createUser('auth-hardening-e2e-disabled@test.local');
      const dt = await downloadToken(user.token);

      // Controls: both tokens work before the account is disabled.
      await getWithBearer('/api/filters', user.token).expect(200);
      await getWithBearer('/api/files/note.txt', user.token).expect(200);
      await getWithDt('/api/files/note.txt', dt).expect(200);

      await server()
        .patch(`/api/admin/users/${user.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ disabled: true })
        .expect(200);

      await getWithBearer('/api/filters', user.token).expect(401);
      await getWithBearer('/api/files/note.txt', user.token).expect(401);
      await getWithDt('/api/files/note.txt', dt).expect(401);
      await getWithBearer('/auth/me', user.token).expect(401);
      await getWithBearer('/auth/download-token', user.token).expect(401);

      // Re-enabling restores access with the same tokens.
      await server()
        .patch(`/api/admin/users/${user.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ disabled: false })
        .expect(200);
      await getWithBearer('/api/filters', user.token).expect(200);
    });
  });

  describe('deleted users', () => {
    it("a deleted user's tokens → 401", async () => {
      const user = await createUser('auth-hardening-e2e-deleted@test.local');
      const dt = await downloadToken(user.token);
      await getWithBearer('/api/filters', user.token).expect(200);

      await server()
        .delete(`/api/admin/users/${user.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      await getWithBearer('/api/filters', user.token).expect(401);
      await getWithBearer('/auth/me', user.token).expect(401);
      await getWithBearer('/api/files/note.txt', user.token).expect(401);
      await getWithDt('/api/files/note.txt', dt).expect(401);
    });
  });

  describe('role comes from the database, not the token', () => {
    it('a token minted as admin loses /api/admin/users once the DB role is user', async () => {
      const user = await createUser('auth-hardening-e2e-demoted@test.local');
      withDb((db) =>
        db.prepare(`UPDATE users SET role = 'admin' WHERE id = ?`).run(user.id),
      );
      // Log in again so the token's own `role` claim says admin.
      const adminClaimToken = await login(
        'auth-hardening-e2e-demoted@test.local',
      );
      await getWithBearer('/api/admin/users', adminClaimToken).expect(200);

      withDb((db) =>
        db.prepare(`UPDATE users SET role = 'user' WHERE id = ?`).run(user.id),
      );
      await getWithBearer('/api/admin/users', adminClaimToken).expect(403);
    });

    it('a token minted as user gains /api/admin/users once the DB role is admin', async () => {
      const user = await createUser('auth-hardening-e2e-promoted@test.local');
      await getWithBearer('/api/admin/users', user.token).expect(403);
      withDb((db) =>
        db.prepare(`UPDATE users SET role = 'admin' WHERE id = ?`).run(user.id),
      );
      await getWithBearer('/api/admin/users', user.token).expect(200);
    });
  });

  describe('email-verified gate on file routes', () => {
    it("an unverified user's bearer token → 403 on a file route, same as /api/*", async () => {
      const user = await createUser(
        'auth-hardening-e2e-unverified@test.local',
        {
          verified: false,
        },
      );
      await getWithBearer('/api/filters', user.token).expect(403);
      await getWithBearer('/api/files/note.txt', user.token).expect(403);
      // ...and it cannot mint a download token to sidestep the gate either.
      await getWithBearer('/auth/download-token', user.token).expect(403);
    });

    it('once verified in the DB, the same token passes on the file route', async () => {
      const user = await createUser(
        'auth-hardening-e2e-later-verified@test.local',
        { verified: false },
      );
      await getWithBearer('/api/files/note.txt', user.token).expect(403);
      withDb((db) =>
        db
          .prepare('UPDATE users SET email_verified = 1 WHERE id = ?')
          .run(user.id),
      );
      await getWithBearer('/api/files/note.txt', user.token).expect(200);
    });
  });
});
