import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import Database from 'better-sqlite3';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PIPELINE_CLOCK } from '../src/pipeline/pipeline.service';
import {
  buildContractDb,
  EXPECTED,
  NOW,
  toApiShape,
} from './fixtures/pipeline_snapshot/contract';

// docs/PIPELINE_VIZ_PLAN.md M2 — GET /api/pipeline/snapshot over the bot's
// contract fixture (test/fixtures/pipeline_snapshot/), with the clock frozen
// at the fixture's NOW. The fixture's 'u1'/'u2' rows are re-owned by two real
// accounts once they exist, so scoping is checked through the real JWT path.
describe('PipelineModule (e2e)', () => {
  let app: INestApplication<App>;
  let trackerDbPath: string;
  let tokenA: string;
  let tokenB: string;
  let userIdA: string;
  const emailA = 'pipeline-e2e-a@test.local';
  const emailB = 'pipeline-e2e-b@test.local';
  const password = 'pipeline-e2e-password-1';

  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), 'pipeline-e2e-'));
    const appDbPath = join(root, 'app.sqlite');
    trackerDbPath = join(root, 'tracker.db');
    buildContractDb(trackerDbPath);
    process.env.JWT_SECRET = 'e2e-pipeline-secret-'.repeat(4);
    process.env.APP_DB_PATH = appDbPath;
    process.env.TRACKER_DB_PATH = trackerDbPath;
    process.env.USERS_ROOT = join(root, 'users');
    process.env.SEED_USER_EMAIL = emailA;
    process.env.SEED_USER_PASSWORD = password;
    process.env.REGISTRATION_ENABLED = 'true';
    delete process.env.APPLY_FAILURES_LOG_PATH;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PIPELINE_CLOCK)
      .useValue(() => NOW)
      .compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api', { exclude: ['auth/{*path}', 'health'] });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
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
    const appDb = new Database(appDbPath);
    appDb
      .prepare('UPDATE users SET email_verified = 1 WHERE email = ?')
      .run(emailB);
    appDb.close();
    const loginB = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: emailB, password })
      .expect(201);
    tokenB = loginB.body.accessToken as string;
    const meB = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${tokenB}`)
      .expect(200);
    const userIdB = meB.body.id as string;

    const tracker = new Database(trackerDbPath);
    for (const table of ['applications', 'generation_runs']) {
      tracker
        .prepare(`UPDATE ${table} SET user_id = ? WHERE user_id = 'u1'`)
        .run(userIdA);
      tracker
        .prepare(`UPDATE ${table} SET user_id = ? WHERE user_id = 'u2'`)
        .run(userIdB);
    }
    tracker.close();
  });

  afterAll(async () => {
    await app?.close();
  });

  const get = (path: string, token?: string) => {
    const req = request(app.getHttpServer()).get(path);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };

  it('401 without a token', () => get('/api/pipeline/snapshot').expect(401));

  it.each(['0', '31', 'x', '1.5', '-1', ''])(
    '400 for days=%p',
    async (days) => {
      await get(`/api/pipeline/snapshot?days=${days}`, tokenA).expect(400);
    },
  );

  it('returns the contract snapshot for the owner (default days=1)', async () => {
    const { body } = await get('/api/pipeline/snapshot', tokenA).expect(200);
    const expected = toApiShape(EXPECTED);
    expected.user_id = userIdA;
    // The route uses the contract's default of 15 events; the fixture's
    // expected.json was cut with 10 — compare those, then the count.
    const { events, ...rest } = body;
    const { events: expectedEvents, ...expectedRest } = expected;
    expect(rest).toEqual(expectedRest);
    expect(events).toHaveLength(15);
    expect(events.slice(0, 10)).toEqual(expectedEvents);
    // apply_failures.jsonl is not configured → null, a valid contract value.
    expect(body.apply.failures.log_records).toBeNull();
    // Nothing read from the bot's .env / scheduler leaks into the response.
    expect(body.hunt.next_slot).toBeUndefined();
    expect(body.coverage).toBeUndefined();
    expect(body.apply.queue_enabled_local_config).toBeUndefined();
  });

  it('accepts days=30 and widens the window', async () => {
    const { body } = await get('/api/pipeline/snapshot?days=30', tokenA).expect(
      200,
    );
    expect(body.window.days).toBe(30);
    expect(body.window.label).toBe('last 30 days');
    expect(body.hunt.hunt_runs.hunts).toBe(3);
  });

  it('a second user sees the shared hunt tier and only their own rows', async () => {
    const [a, b] = await Promise.all([
      get('/api/pipeline/snapshot', tokenA).expect(200),
      get('/api/pipeline/snapshot', tokenB).expect(200),
    ]);
    expect(b.body.hunt.hunt_runs).toEqual(a.body.hunt.hunt_runs);
    expect(b.body.hunt.postings_seen).toEqual(a.body.hunt.postings_seen);
    expect(b.body.hunt.entered_tracker.rows).toBe(1);
    expect(b.body.apply.pending.count).toBe(0);
    expect(b.body.apply.in_progress.count).toBe(0);
    expect(b.body.result.ready.count).toBe(1);
    expect(b.body.events).toEqual([]);
    expect(JSON.stringify(b.body)).not.toMatch(/Example Corp|Acme|Gamma/);
  });

  it('never writes to tracker.db', async () => {
    const tracker = new Database(trackerDbPath, { readonly: true });
    const before = tracker
      .prepare('SELECT COUNT(*) AS n, MAX(rowid) AS r FROM applications')
      .get();
    await get('/api/pipeline/snapshot?days=7', tokenA).expect(200);
    expect(
      tracker
        .prepare('SELECT COUNT(*) AS n, MAX(rowid) AS r FROM applications')
        .get(),
    ).toEqual(before);
    tracker.close();
  });

  describe('commands', () => {
    const post = (body: unknown, token?: string) => {
      const req = request(app.getHttpServer())
        .post('/api/pipeline/commands')
        .send(body as object);
      return token ? req.set('Authorization', `Bearer ${token}`) : req;
    };
    const exec = (sql: string) => {
      const tracker = new Database(trackerDbPath);
      tracker.exec(sql);
      tracker.close();
    };

    it('401 without a token', async () => {
      await post({ kind: 'hunt' }).expect(401);
      await get('/api/pipeline/commands/c_exp').expect(401);
    });

    it('403 for a non-owner, on both routes', async () => {
      await post({ kind: 'check_expired' }, tokenB).expect(403);
      await get('/api/pipeline/commands/c_exp', tokenB).expect(403);
    });

    it.each([
      [{}],
      [{ kind: 'deploy' }],
      [{ kind: 'hunt', sources: 'linkedin' }],
      [{ kind: 'hunt', sources: [] }],
      [{ kind: 'hunt', sources: [1] }],
      [{ kind: 'hunt', sources: [''] }],
      [{ kind: 'retry_failed', sources: ['linkedin'] }],
      [{ kind: 'hunt', sources: ['nope'] }],
    ])('400 for %j', async (body) => {
      await post(body, tokenA).expect(400);
    });

    it('409 for hunt / retry_failed while the fixture hunt is live', async () => {
      const res = await post({ kind: 'hunt' }, tokenA).expect(409);
      expect(res.body.message).toMatch(/h_live/);
      await post({ kind: 'retry_failed' }, tokenA).expect(409);
    });

    it('check_expired is accepted during a hunt, once', async () => {
      const { body } = await post({ kind: 'check_expired' }, tokenA).expect(
        201,
      );
      expect(Object.keys(body)).toEqual(['id']);
      const cmd = await get(`/api/pipeline/commands/${body.id}`, tokenA).expect(
        200,
      );
      expect(cmd.body).toEqual({
        id: body.id,
        kind: 'check_expired',
        payload: {},
        status: 'pending',
        error: '',
        result: '',
        created_at: '2026-09-22T12:00:00+00:00',
        started_at: null,
        finished_at: null,
      });
      await post({ kind: 'check_expired' }, tokenA).expect(409);
      // The new command is the newest in the snapshot's control block.
      const snap = await get('/api/pipeline/snapshot', tokenA).expect(200);
      expect(snap.body.control.commands[0]).toMatchObject({
        id: body.id,
        status: 'pending',
      });
      expect(snap.body.hunt.live.active.hunt_id).toBe('h_live');
      exec(`UPDATE bot_commands SET status = 'done' WHERE id = '${body.id}'`);
    });

    it('409 while a hunt command is still running, 201 once idle', async () => {
      exec(
        "UPDATE hunt_live SET step = 'done', finished_at = '2026-09-22T11:59:00+00:00'",
      );
      // c_hunt (fixture) is still `running`.
      await post({ kind: 'retry_failed' }, tokenA).expect(409);
      exec("UPDATE bot_commands SET status = 'done' WHERE id = 'c_hunt'");

      const { body } = await post(
        { kind: 'hunt', sources: ['linkedin', 'justjoin'] },
        tokenA,
      ).expect(201);
      const cmd = await get(`/api/pipeline/commands/${body.id}`, tokenA).expect(
        200,
      );
      expect(cmd.body.payload).toEqual({ sources: ['linkedin', 'justjoin'] });

      const tracker = new Database(trackerDbPath, { readonly: true });
      expect(
        tracker
          .prepare('SELECT user_id FROM bot_commands WHERE id = ?')
          .get(body.id),
      ).toEqual({ user_id: userIdA });
      tracker.close();

      // The new pending hunt blocks the next one.
      await post({ kind: 'hunt' }, tokenA).expect(409);
      exec(`UPDATE bot_commands SET status = 'done' WHERE id = '${body.id}'`);
    });

    it('503 when the bot has not published its sources', async () => {
      exec("DELETE FROM config WHERE key = 'bot_state.sources'");
      const res = await post(
        { kind: 'hunt', sources: ['linkedin'] },
        tokenA,
      ).expect(503);
      expect(res.body.message).toBe('bot state unavailable');
    });

    it('404 for an unknown command id', async () => {
      await get('/api/pipeline/commands/does-not-exist', tokenA).expect(404);
    });
  });
});
