import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import Database from 'better-sqlite3';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';

/**
 * docs/PROFILE_PAGE_TABS.md T3 — isOwner on GET /auth/me.
 *
 * OWNER_USER_ID isn't knowable before the owner account exists (it's a
 * randomUUID minted by `AuthService.registerOwner` at seed time), so this
 * spec runs in two phases against the SAME on-disk app.sqlite/tracker.db/
 * users root: phase 1 boots a normal app instance to seed the owner and
 * register a second, non-owner user, discovering both ids; phase 2 sets
 * OWNER_USER_ID to the discovered owner id and boots a FRESH app instance
 * against the same files (the seed step in AuthService.onModuleInit no-ops
 * once users already exist) — mirroring how a real deployment configures
 * the env var once the owner's real user id is known, then restarts.
 * JWTs minted in phase 1 stay valid in phase 2 (same JWT_SECRET).
 */
describe('isOwner on GET /auth/me (e2e)', () => {
  let app1: INestApplication<App>;
  let app2: INestApplication<App>;
  let appDbPath: string;
  const emailOwner = 'auth-owner-e2e-owner@test.local';
  const emailOther = 'auth-owner-e2e-other@test.local';
  const password = 'auth-owner-e2e-password-1';

  let tokenOwner: string;
  let tokenOther: string;
  let ownerId: string;
  let otherId: string;

  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), 'auth-owner-e2e-'));
    appDbPath = join(root, 'app.sqlite');
    process.env.JWT_SECRET = 'e2e-auth-owner-secret-'.repeat(4);
    process.env.APP_DB_PATH = appDbPath;
    process.env.TRACKER_DB_PATH = join(root, 'tracker.db');
    process.env.USERS_ROOT = join(root, 'users');
    process.env.SEED_USER_EMAIL = emailOwner;
    process.env.SEED_USER_PASSWORD = password;
    process.env.REGISTRATION_ENABLED = 'true';
    delete process.env.OWNER_USER_ID;

    // Phase 1: no OWNER_USER_ID configured — isOwner now derives from
    // role='admin' (the seeded owner), so the owner is TRUE with zero config
    // (revised 2026-09-01: the deploy workflow rewrites .env on the VPS, so
    // an env-only mechanism was wiped on every deploy) and the registered
    // second user (role 'user') is false.
    const moduleFixture1: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app1 = moduleFixture1.createNestApplication();
    app1.setGlobalPrefix('api', { exclude: ['auth/{*path}', 'health'] });
    await app1.init();

    const loginOwner = await request(app1.getHttpServer())
      .post('/auth/login')
      .send({ email: emailOwner, password })
      .expect(201);
    tokenOwner = loginOwner.body.accessToken as string;

    const meOwnerBefore = await request(app1.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${tokenOwner}`)
      .expect(200);
    ownerId = meOwnerBefore.body.id as string;
    expect(meOwnerBefore.body.isOwner).toBe(true);

    await request(app1.getHttpServer())
      .post('/auth/register')
      .send({ email: emailOther, password })
      .expect(201);

    const db = new Database(appDbPath);
    db.prepare('UPDATE users SET email_verified = 1 WHERE email = ?').run(
      emailOther,
    );
    db.close();

    const loginOther = await request(app1.getHttpServer())
      .post('/auth/login')
      .send({ email: emailOther, password })
      .expect(201);
    tokenOther = loginOther.body.accessToken as string;

    const meOtherBefore = await request(app1.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${tokenOther}`)
      .expect(200);
    expect(meOtherBefore.body.isOwner).toBe(false);
    otherId = meOtherBefore.body.id as string;

    await app1.close();

    // Phase 2: OWNER_USER_ID is now an optional NARROWING override — when
    // set, it alone decides ownership, role included. Point it at the
    // non-admin second user and boot a fresh app against the same on-disk
    // state: the admin must lose isOwner, the named user must gain it.
    process.env.OWNER_USER_ID = otherId;
    const moduleFixture2: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app2 = moduleFixture2.createNestApplication();
    app2.setGlobalPrefix('api', { exclude: ['auth/{*path}', 'health'] });
    await app2.init();
  });

  afterAll(async () => {
    await app2?.close();
    delete process.env.OWNER_USER_ID;
  });

  it('an OWNER_USER_ID override beats role — the admin loses isOwner', async () => {
    const res = await request(app2.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${tokenOwner}`)
      .expect(200);
    expect(res.body.id).toBe(ownerId);
    expect(res.body.isOwner).toBe(false);
  });

  it('the user named by the override gains isOwner despite role user', async () => {
    const res = await request(app2.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${tokenOther}`)
      .expect(200);
    expect(res.body.id).toBe(otherId);
    expect(res.body.isOwner).toBe(true);
  });

  it('unauthenticated GET /auth/me is unchanged (401, no body leak)', async () => {
    const res = await request(app2.getHttpServer()).get('/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.isOwner).toBeUndefined();
  });
});
