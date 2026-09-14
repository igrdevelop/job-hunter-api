import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';

// AuthController is throttled 30/min per client IP. Behind Cloudflare Tunnel
// every request arrives from the cloudflared container, so the tracker is
// CF-Connecting-IP when it holds a valid IP, else req.ip.
// POST /auth/verify with a bogus token is the cheapest @Public() auth route
// (403, no bcrypt, no mail) — the throttle counts it all the same.
describe('AuthController client-IP throttle (e2e)', () => {
  let app: INestApplication<App>;
  const LIMIT = 30;

  const verify = (cfIp?: string) => {
    const req = request(app.getHttpServer())
      .post('/auth/verify')
      .send({ token: 'bogus' });
    return cfIp === undefined ? req : req.set('CF-Connecting-IP', cfIp);
  };

  const exhaust = async (cfIp?: string) => {
    for (let i = 0; i < LIMIT; i++) {
      await verify(cfIp).expect(403);
    }
  };

  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), 'auth-throttle-e2e-'));
    process.env.JWT_SECRET = 'e2e-auth-throttle-secret-'.repeat(4);
    process.env.APP_DB_PATH = join(root, 'app.sqlite');
    process.env.TRACKER_DB_PATH = join(root, 'tracker.db');
    process.env.USERS_ROOT = join(root, 'users');
    delete process.env.SEED_USER_EMAIL;
    delete process.env.SEED_USER_PASSWORD;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api', { exclude: ['auth/{*path}', 'health'] });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('gives each CF-Connecting-IP its own bucket', async () => {
    await exhaust('203.0.113.10');
    await verify('203.0.113.10').expect(429);

    // A different client behind the same tunnel is unaffected.
    await verify('203.0.113.20').expect(403);
    await verify('2001:db8::1').expect(403);
    // Only the first entry of a list is used.
    await verify('203.0.113.10, 198.51.100.7').expect(429);
  });

  it('falls back to req.ip when the header is absent or not an IP', async () => {
    // The fallback bucket is still fresh: the header-keyed test above did not
    // consume it.
    await verify('not-an-ip').expect(403);
    for (let i = 1; i < LIMIT; i++) {
      await verify().expect(403);
    }
    await verify().expect(429);
    await verify('not-an-ip').expect(429);
    // A valid header still escapes the exhausted req.ip bucket.
    await verify('203.0.113.30').expect(403);
  });
});
