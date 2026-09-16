import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';

// Non-ASCII file names on download routes used to 500 (Node's
// ERR_INVALID_CHAR on a hand-built `filename="..."` header).
describe('Content-Disposition for non-ASCII file names (e2e)', () => {
  let app: INestApplication<App>;
  let usersRoot: string;
  let token: string;
  let userId: string;
  const email = 'content-disposition-e2e@test.local';
  const password = 'content-disposition-e2e-password-1';
  const pdfBytes = Buffer.from('%PDF-1.4\n% e2e fixture\n');

  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), 'content-disposition-e2e-'));
    usersRoot = join(root, 'users');
    process.env.JWT_SECRET = 'e2e-content-disposition-secret-'.repeat(3);
    process.env.APP_DB_PATH = join(root, 'app.sqlite');
    process.env.TRACKER_DB_PATH = join(root, 'tracker.db');
    process.env.USERS_ROOT = usersRoot;
    process.env.SEED_USER_EMAIL = email;
    process.env.SEED_USER_PASSWORD = password;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api', { exclude: ['auth/{*path}', 'health'] });
    await app.init();

    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(201);
    token = (login.body as { accessToken: string }).accessToken;

    const me = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    userId = (me.body as { id: string }).id;
  });

  afterAll(async () => {
    await app?.close();
  });

  function get(path: string) {
    return request(app.getHttpServer())
      .get(path)
      .set('Authorization', `Bearer ${token}`);
  }

  it('GET /api/generated/:date/:company/:file serves a Polish file name', async () => {
    const company = 'Wrocław Sp. z o.o.';
    const file = 'Wrocław_CV.pdf';
    const dir = join(usersRoot, userId, 'Applications', '2026-09-14', company);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, file), pdfBytes);

    const res = await get(
      `/api/generated/2026-09-14/${encodeURIComponent(company)}/${encodeURIComponent(file)}`,
    ).expect(200);

    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toBe(
      `inline; filename="Wroc_aw_CV.pdf"; filename*=UTF-8''Wroc%C5%82aw_CV.pdf`,
    );
    expect(Buffer.from(res.body as Buffer).equals(pdfBytes)).toBe(true);
  });

  it('GET /api/files/{*path} serves a Polish file name from candidate/', async () => {
    const dir = join(usersRoot, userId, 'candidate', 'Życiorysy');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'Łódź notatki.docx'), pdfBytes);

    const res = await get(
      `/api/files/${encodeURIComponent('Życiorysy')}/${encodeURIComponent('Łódź notatki.docx')}`,
    ).expect(200);

    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="_odz notatki.docx"; filename*=UTF-8''%C5%81%C3%B3d%C5%BA%20notatki.docx`,
    );
  });

  it('GET /api/templates/:id/content serves a template uploaded with a Cyrillic name', async () => {
    const name = 'Резюме (основное)';
    const upload = await request(app.getHttpServer())
      .post('/api/templates')
      .set('Authorization', `Bearer ${token}`)
      .field('name', name)
      .field('category', 'resume')
      .attach('file', pdfBytes, 'resume.pdf')
      .expect(201);
    const id = (upload.body as { id: string }).id;

    const res = await get(`/api/templates/${id}/content`).expect(200);

    expect(res.headers['content-type']).toBe('application/pdf');
    const header = res.headers['content-disposition'];
    expect(header).toBe(
      `inline; filename="______ (________).pdf"; filename*=UTF-8''${encodeURIComponent(name).replace(/[()]/g, (c) => (c === '(' ? '%28' : '%29'))}.pdf`,
    );
    const encoded = /filename\*=UTF-8''(.+)$/.exec(header)![1];
    expect(decodeURIComponent(encoded)).toBe(`${name}.pdf`);
  });
});
