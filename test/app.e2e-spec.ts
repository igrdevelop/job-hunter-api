import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

describe('AppModule (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(() => {
    // E2E must boot without a local .env or ./data/ (CI, fresh clones,
    // worktrees) — point every storage path at a temp dir like the other
    // e2e specs do.
    const root = mkdtempSync(join(tmpdir(), 'app-e2e-'));
    process.env.JWT_SECRET = 'e2e-test-secret-'.repeat(4);
    process.env.APP_DB_PATH = join(root, 'app.sqlite');
    process.env.TRACKER_DB_PATH = join(root, 'tracker.db');
    process.env.USERS_ROOT = join(root, 'users');
  });

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api', { exclude: ['auth/{*path}', 'health'] });
    await app.init();
  });

  it('/health (GET)', () => {
    return request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect(({ body }) => {
        expect(body.status).toBe('ok');
      });
  });

  afterEach(async () => {
    await app.close();
  });
});
