import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';

describe('FiltersModule (e2e)', () => {
  let app: INestApplication<App>;
  let token: string;
  let usersRoot: string;
  let userId: string;
  const email = 'filters-e2e@test.local';
  const password = 'filters-e2e-password-1';

  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), 'filters-e2e-'));
    usersRoot = join(root, 'users');
    process.env.JWT_SECRET = 'e2e-filters-secret-'.repeat(4);
    process.env.APP_DB_PATH = join(root, 'app.sqlite');
    process.env.TRACKER_DB_PATH = join(root, 'tracker.db');
    process.env.USERS_ROOT = usersRoot;
    process.env.SEED_USER_EMAIL = email;
    process.env.SEED_USER_PASSWORD = password;
    process.env.REGISTRATION_ENABLED = 'false';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api', { exclude: ['auth/{*path}', 'health'] });
    await app.init();

    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect((res) => {
        if (res.status !== 200 && res.status !== 201) {
          throw new Error(`login expected 200/201, got ${res.status}`);
        }
      });

    token = login.body.accessToken as string;

    const me = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    userId = me.body.id as string;
  });

  afterAll(async () => {
    await app?.close();
  });

  function filtersPath(): string {
    return join(usersRoot, userId, 'candidate', 'filters.yaml');
  }

  it('GET missing file → defaults, empty overrides, effective=defaults', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/filters')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.overrides).toEqual({});
    expect(res.body.defaults.title_keywords).toEqual([
      'angular',
      'frontend',
      'front-end',
      'javascript',
      'typescript',
    ]);
    expect(res.body.effective.title_keywords).toEqual(
      res.body.defaults.title_keywords,
    );
    expect(res.body.meta.exclude_companies.merge).toBe('extend_only');
    expect(res.body.meta.locations.derived).toBe('candidate.yaml');
    expect(existsSync(filtersPath())).toBe(false);
  });

  it('PUT round-trip writes YAML and returns merged payload', async () => {
    const res = await request(app.getHttpServer())
      .put('/api/filters')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title_keywords: ['react', 'frontend'],
        exclude_german_language_required: false,
        exclude_companies: ['localmill'],
      })
      .expect(200);

    expect(res.body.overrides.title_keywords).toEqual(['react', 'frontend']);
    expect(res.body.overrides.exclude_german_language_required).toBe(false);
    expect(res.body.overrides.exclude_companies).toEqual(['localmill']);
    expect(res.body.effective.title_keywords).toEqual(['react', 'frontend']);
    expect(res.body.effective.exclude_companies).toContain('micro1');
    expect(res.body.effective.exclude_companies).toContain('localmill');

    expect(existsSync(filtersPath())).toBe(true);
    const onDisk = readFileSync(filtersPath(), 'utf8');
    expect(onDisk).toContain('title_keywords');
    expect(onDisk).toContain('localmill');
    expect(onDisk).not.toContain('micro1');
  });

  it('PUT invalid → 400 and file untouched', async () => {
    const before = readFileSync(filtersPath(), 'utf8');

    const res = await request(app.getHttpServer())
      .put('/api/filters')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title_keywords: ['react'],
        exclude_patterns: ['(unbalanced'],
      })
      .expect(400);

    const errors =
      res.body.errors ?? res.body.message?.errors ?? res.body.message;
    expect(errors).toBeDefined();
    expect(errors['exclude_patterns[0]'] ?? errors).toBeTruthy();
    if (typeof errors === 'object' && errors['exclude_patterns[0]']) {
      expect(errors['exclude_patterns[0]']).toMatch(/invalid regex|portable/i);
    }

    expect(readFileSync(filtersPath(), 'utf8')).toBe(before);
  });

  it('PUT extend_only partial builtins → 400', async () => {
    const before = readFileSync(filtersPath(), 'utf8');

    const res = await request(app.getHttpServer())
      .put('/api/filters')
      .set('Authorization', `Bearer ${token}`)
      .send({ exclude_companies: ['micro1', 'localmill'] })
      .expect(400);

    const errors = res.body.errors ?? res.body.message?.errors;
    expect(errors.exclude_companies).toMatch(/cannot remove builtin/);
    expect(readFileSync(filtersPath(), 'utf8')).toBe(before);
  });

  it('PUT strips key==default before write', async () => {
    await request(app.getHttpServer())
      .put('/api/filters')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title_keywords: [
          'angular',
          'frontend',
          'front-end',
          'javascript',
          'typescript',
        ],
        exclude_german_language_required: false,
      })
      .expect(200);

    const onDisk = readFileSync(filtersPath(), 'utf8');
    expect(onDisk).not.toContain('title_keywords');
    expect(onDisk).toContain('exclude_german_language_required');
  });

  it('GET corrupt filters.yaml → 422 (not empty overrides)', async () => {
    mkdirSync(join(usersRoot, userId, 'candidate'), { recursive: true });
    const corrupt = 'title_keywords: [\n  - unclosed';
    writeFileSync(filtersPath(), corrupt, 'utf8');

    const res = await request(app.getHttpServer())
      .get('/api/filters')
      .set('Authorization', `Bearer ${token}`)
      .expect(422);

    const errors = res.body.errors ?? res.body.message?.errors;
    expect(errors._).toMatch(/could not be parsed/i);
    // File left untouched so a later PUT can repair it.
    expect(readFileSync(filtersPath(), 'utf8')).toBe(corrupt);

    // Restore a valid file for any follow-up tests in this suite.
    writeFileSync(filtersPath(), 'exclude_german_language_required: false\n', 'utf8');
  });

  it('GET strips derived locations from overrides', async () => {
    mkdirSync(join(usersRoot, userId, 'candidate'), { recursive: true });
    writeFileSync(
      filtersPath(),
      [
        'title_keywords:',
        '  - react',
        'locations:',
        '  - mars',
        '',
      ].join('\n'),
      'utf8',
    );

    const res = await request(app.getHttpServer())
      .get('/api/filters')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.overrides.title_keywords).toEqual(['react']);
    expect(res.body.overrides.locations).toBeUndefined();
    expect(res.body.effective.locations).toEqual(res.body.defaults.locations);
    expect(res.body.effective.locations).not.toContain('mars');
  });
});
