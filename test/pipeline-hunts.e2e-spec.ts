import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PIPELINE_CLOCK } from '../src/pipeline/pipeline.service';
import {
  buildHuntsContractDb,
  EXPECTED_HUNT_DETAIL,
  EXPECTED_HUNTS,
  HUNTS_NOW,
} from './fixtures/pipeline_hunts/contract';

// GET /api/pipeline/hunts and /api/pipeline/hunts/:huntId over the bot's
// hunts contract fixture (test/fixtures/pipeline_hunts/), clock frozen at the
// fixture's instant. The fixture's 'u1' rows are re-owned by the seeded
// account, so the per-vacancy scoping goes through the real JWT path.
describe('Pipeline hunts (e2e)', () => {
  let app: INestApplication<App>;
  let trackerDbPath: string;
  let token: string;
  let otherToken: string;
  const email = 'pipeline-hunts-e2e@test.local';
  const password = 'pipeline-hunts-e2e-password-1';

  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), 'pipeline-hunts-e2e-'));
    trackerDbPath = join(root, 'tracker.db');
    buildHuntsContractDb(trackerDbPath);
    process.env.JWT_SECRET = 'e2e-pipeline-hunts-secret-'.repeat(3);
    process.env.APP_DB_PATH = join(root, 'app.sqlite');
    process.env.TRACKER_DB_PATH = trackerDbPath;
    process.env.USERS_ROOT = join(root, 'users');
    process.env.SEED_USER_EMAIL = email;
    process.env.SEED_USER_PASSWORD = password;
    process.env.REGISTRATION_ENABLED = 'true';
    delete process.env.APPLY_FAILURES_LOG_PATH;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PIPELINE_CLOCK)
      .useValue(() => HUNTS_NOW)
      .compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api', { exclude: ['auth/{*path}', 'health'] });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();

    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(201);
    token = login.body.accessToken as string;
    const me = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    // A second, non-owner account (registration + verified email).
    const otherEmail = 'pipeline-hunts-e2e-b@test.local';
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: otherEmail, password })
      .expect(201);
    const appDb = new Database(join(root, 'app.sqlite'));
    appDb
      .prepare('UPDATE users SET email_verified = 1 WHERE email = ?')
      .run(otherEmail);
    appDb.close();
    const loginB = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: otherEmail, password })
      .expect(201);
    otherToken = loginB.body.accessToken as string;

    const tracker = new Database(trackerDbPath);
    for (const table of ['applications', 'generation_runs']) {
      tracker
        .prepare(`UPDATE ${table} SET user_id = ? WHERE user_id = 'u1'`)
        .run(me.body.id);
    }
    tracker.close();
  });

  afterAll(async () => {
    await app?.close();
  });

  const get = (path: string, auth = true) => {
    const req = request(app.getHttpServer()).get(path);
    return auth ? req.set('Authorization', `Bearer ${token}`) : req;
  };

  it('401 without a token', async () => {
    await get('/api/pipeline/hunts', false).expect(401);
    await get('/api/pipeline/hunts/h_done', false).expect(401);
  });

  it('403 for a non-owner, on both routes', async () => {
    for (const path of ['/api/pipeline/hunts', '/api/pipeline/hunts/h_done']) {
      await request(app.getHttpServer())
        .get(path)
        .set('Authorization', `Bearer ${otherToken}`)
        .expect(403);
    }
  });

  it('lists the hunts exactly as the bot contract says', async () => {
    const { body } = await get('/api/pipeline/hunts').expect(200);
    expect(body).toEqual(EXPECTED_HUNTS);
  });

  it.each(['0', '201', 'x', '1.5'])('400 for limit=%p', async (limit) => {
    await get(`/api/pipeline/hunts?limit=${limit}`).expect(400);
  });

  it('limit keeps the newest', async () => {
    const { body } = await get('/api/pipeline/hunts?limit=1').expect(200);
    expect(body.hunts.map((h: { hunt_id: string }) => h.hunt_id)).toEqual([
      'h_run',
    ]);
  });

  it('opens one hunt exactly as the bot contract says', async () => {
    const { body } = await get('/api/pipeline/hunts/h_done').expect(200);
    expect(body).toEqual(EXPECTED_HUNT_DETAIL);
  });

  it('404 for an unknown hunt, 400 for a malformed id', async () => {
    await get('/api/pipeline/hunts/nope').expect(404);
    await get('/api/pipeline/hunts/bad%20id').expect(400);
  });

  it('never writes to tracker.db', async () => {
    const before = readFileSync(trackerDbPath);
    await get('/api/pipeline/hunts').expect(200);
    await get('/api/pipeline/hunts/h_done').expect(200);
    expect(readFileSync(trackerDbPath).equals(before)).toBe(true);
  });
});
