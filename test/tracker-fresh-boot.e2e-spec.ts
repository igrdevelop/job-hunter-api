import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import Database from 'better-sqlite3';
import { copyFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';

/**
 * A fresh deployment: an empty app.sqlite, SEED_USER_* set, and a pre-
 * multi-user tracker.db (test/fixtures/tracker.db — no user_id column).
 * The API must boot, create the per-user unique index, and hand every legacy
 * row to the seeded owner. Two bugs broke this: the migration's unique index
 * died on duplicate url_norm rows (and, not being transactional, left a
 * half-migrated DB that "booted" on the second try), and the owner backfill
 * ran in TrackerService's constructor — before AuthService.onModuleInit
 * seeded the owner — so every row got user_id = ''.
 */
const FIXTURE = join(__dirname, 'fixtures', 'tracker.db');
const FIXTURE_ROWS = 12;

function setEnv(root: string, email: string, password: string): string {
  const trackerPath = join(root, 'tracker.db');
  copyFileSync(FIXTURE, trackerPath);
  process.env.JWT_SECRET = 'e2e-fresh-boot-secret-'.repeat(4);
  process.env.APP_DB_PATH = join(root, 'app.sqlite');
  process.env.TRACKER_DB_PATH = trackerPath;
  process.env.USERS_ROOT = join(root, 'users');
  process.env.SEED_USER_EMAIL = email;
  process.env.SEED_USER_PASSWORD = password;
  delete process.env.OWNER_USER_ID;
  return trackerPath;
}

describe('fresh boot on the tracker.db fixture (e2e)', () => {
  const email = 'fresh-boot-owner@test.local';
  const password = 'fresh-boot-password-1';
  let app: INestApplication<App>;
  let trackerPath: string;

  beforeAll(async () => {
    trackerPath = setEnv(
      mkdtempSync(join(tmpdir(), 'fresh-boot-e2e-')),
      email,
      password,
    );
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api', { exclude: ['auth/{*path}', 'health'] });
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('creates the per-user unique url index', () => {
    const db = new Database(trackerPath, { readonly: true });
    try {
      const idx = db
        .prepare(
          `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_user_url_norm'`,
        )
        .get() as { sql: string } | undefined;
      expect(idx?.sql).toMatch(/UNIQUE INDEX/);
    } finally {
      db.close();
    }
  });

  it('gives every legacy row to the seeded owner', async () => {
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(201);
    const token = (login.body as { accessToken: string }).accessToken;

    const res = await request(app.getHttpServer())
      .get('/api/applications?limit=100')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect((res.body as { meta: { total: number } }).meta.total).toBe(
      FIXTURE_ROWS,
    );

    const db = new Database(trackerPath, { readonly: true });
    try {
      const unowned = db
        .prepare(`SELECT COUNT(*) AS c FROM applications WHERE user_id = ''`)
        .get() as { c: number };
      expect(unowned.c).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe('boot on a tracker.db with duplicate url_norm rows (e2e)', () => {
  it('refuses to start, names the duplicates and leaves the DB untouched', async () => {
    const trackerPath = setEnv(
      mkdtempSync(join(tmpdir(), 'dup-boot-e2e-')),
      'dup-boot-owner@test.local',
      'dup-boot-password-1',
    );
    // Re-create the duplicate the fixture used to carry: a second row for an
    // already-tracked URL (the pre-multi-user bot's index was not unique).
    const seed = new Database(trackerPath);
    seed.exec(`
      INSERT INTO applications (id, date, company, title, ats_status, url, url_norm, folder)
      SELECT 'dup00001', date, company, title, ats_status, url, url_norm, folder || '_2'
        FROM applications WHERE id = 'ac33c911'
    `);
    seed.close();

    let app: INestApplication<App> | undefined;
    try {
      const moduleFixture = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      app = moduleFixture.createNestApplication();
      await expect(app.init()).rejects.toThrow(
        /duplicate group\(s\)[\s\S]*1004835668/,
      );
    } finally {
      await app?.close().catch(() => undefined);
    }

    const db = new Database(trackerPath, { readonly: true });
    try {
      const cols = (
        db.prepare('PRAGMA table_info(applications)').all() as {
          name: string;
        }[]
      ).map((r) => r.name);
      expect(cols).not.toContain('user_id');
      const idx = db
        .prepare(`SELECT 1 FROM sqlite_master WHERE name = 'idx_user_url_norm'`)
        .get();
      expect(idx).toBeUndefined();
    } finally {
      db.close();
    }
  });
});
