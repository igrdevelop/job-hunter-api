import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import Database from 'better-sqlite3';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';

/**
 * Body validation on the admin PATCH and the public /auth/verify and
 * /auth/resend routes, plus the admin self-action guard. These routes used
 * to bypass the global ValidationPipe (inline types / @Body('field') are
 * erased at runtime), so e.g. {"disabled":"false"} disabled the account.
 */
describe('Admin + auth body validation (e2e)', () => {
  let app: INestApplication<App>;
  let appDbPath: string;
  let adminToken: string;
  let adminId: string;
  let userId: string;
  const adminEmail = 'admin-validation-e2e-admin@test.local';
  const userEmail = 'admin-validation-e2e-user@test.local';
  const password = 'admin-validation-e2e-password-1';

  const readDisabled = (id: string): number | undefined => {
    const db = new Database(appDbPath, { readonly: true });
    const row = db
      .prepare('SELECT disabled FROM users WHERE id = ?')
      .get(id) as { disabled: number } | undefined;
    db.close();
    return row?.disabled;
  };

  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), 'admin-validation-e2e-'));
    appDbPath = join(root, 'app.sqlite');
    process.env.JWT_SECRET = 'e2e-admin-validation-secret-'.repeat(4);
    process.env.APP_DB_PATH = appDbPath;
    process.env.TRACKER_DB_PATH = join(root, 'tracker.db');
    process.env.USERS_ROOT = join(root, 'users');
    process.env.SEED_USER_EMAIL = adminEmail;
    process.env.SEED_USER_PASSWORD = password;
    process.env.REGISTRATION_ENABLED = 'true';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api', { exclude: ['auth/{*path}', 'health'] });
    // Same pipe as src/main.ts — the behavior under test depends on it.
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();

    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: adminEmail, password })
      .expect(201);
    adminToken = login.body.accessToken as string;

    const me = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    adminId = me.body.id as string;

    const reg = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: userEmail, password })
      .expect(201);
    userId = reg.body.id as string;
  });

  afterAll(async () => {
    await app.close();
  });

  const patchUser = (id: string, body: unknown) =>
    request(app.getHttpServer())
      .patch(`/api/admin/users/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send(body as object);

  describe('PATCH /api/admin/users/:id', () => {
    it('rejects a string "false" with 400 and does NOT disable the user', async () => {
      await patchUser(userId, { disabled: 'false' }).expect(400);
      expect(readDisabled(userId)).toBe(0);
    });

    it.each([['true'], [1], [null]])(
      'rejects non-boolean disabled=%p with 400',
      async (value) => {
        await patchUser(userId, { disabled: value }).expect(400);
        expect(readDisabled(userId)).toBe(0);
      },
    );

    it('accepts real booleans', async () => {
      const on = await patchUser(userId, { disabled: true }).expect(200);
      expect(on.body).toMatchObject({ id: userId, disabled: true });
      expect(readDisabled(userId)).toBe(1);

      const off = await patchUser(userId, { disabled: false }).expect(200);
      expect(off.body).toMatchObject({ id: userId, disabled: false });
      expect(readDisabled(userId)).toBe(0);
    });

    it('returns 404 for an unknown id', async () => {
      await patchUser('00000000-0000-0000-0000-000000000000', {
        disabled: true,
      }).expect(404);
    });

    it('forbids an admin from disabling their own account', async () => {
      await patchUser(adminId, { disabled: true }).expect(403);
      expect(readDisabled(adminId)).toBe(0);
    });
  });

  describe('DELETE /api/admin/users/:id', () => {
    it('forbids an admin from deleting their own account', async () => {
      await request(app.getHttpServer())
        .delete(`/api/admin/users/${adminId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(403);
      expect(readDisabled(adminId)).toBe(0);
      // The admin session still works.
      await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
    });
  });

  describe('POST /auth/verify', () => {
    it.each([
      ['an object token', { token: {} }],
      ['a missing token', {}],
      ['an empty token', { token: '' }],
    ])('rejects %s with 400', async (_label, body) => {
      await request(app.getHttpServer())
        .post('/auth/verify')
        .send(body)
        .expect(400);
    });

    it('still answers 403 for a well-formed but unknown token', async () => {
      await request(app.getHttpServer())
        .post('/auth/verify')
        .send({ token: 'no-such-token' })
        .expect(403);
    });
  });

  describe('POST /auth/resend', () => {
    it.each([
      ['a non-email string', { email: 'not-an-email' }],
      ['an object', { email: {} }],
      ['a missing email', {}],
    ])('rejects %s with 400', async (_label, body) => {
      await request(app.getHttpServer())
        .post('/auth/resend')
        .send(body)
        .expect(400);
    });

    it('returns { ok: true } for a well-formed unknown email', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/resend')
        .send({ email: 'nobody-here@test.local' })
        // Nest's POST default; unchanged by this fix.
        .expect(201);
      expect(res.body).toEqual({ ok: true });
    });
  });
});
