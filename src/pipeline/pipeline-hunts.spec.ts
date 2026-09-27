import Database from 'better-sqlite3';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { huntDetail, huntsList, huntStatus, jobState } from './pipeline-hunts';
import {
  buildHuntsContractDb,
  EXPECTED_HUNT_DETAIL,
  EXPECTED_HUNTS,
  HUNTS_NOW,
  HUNTS_SCHEMA_SQL,
} from '../../test/fixtures/pipeline_hunts/contract';

// Contract fixtures copied from the bot repo (test/fixtures/pipeline_hunts/README.md).
const asJson = (v: unknown) => JSON.parse(JSON.stringify(v));

function tmpDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'pipeline-hunts-')), 'tracker.db');
}

function contractDb(): Database.Database {
  const path = tmpDbPath();
  buildHuntsContractDb(path);
  return new Database(path, { readonly: true });
}

const opts = { userId: 'u1', now: HUNTS_NOW };

describe('pipeline hunts — contract fixture', () => {
  let db: Database.Database;
  beforeAll(() => {
    db = contractDb();
  });
  afterAll(() => db.close());

  it('hunts list equals the bot tool output', () => {
    expect(asJson(huntsList(db, opts))).toEqual(EXPECTED_HUNTS);
  });

  it('hunt detail equals the bot tool output', () => {
    expect(asJson(huntDetail(db, 'h_done', opts))).toEqual(
      EXPECTED_HUNT_DETAIL,
    );
  });

  it('limit keeps the newest hunts', () => {
    const list = huntsList(db, { ...opts, limit: 2 }) as {
      hunts: { hunt_id: string }[];
    };
    expect(list.hunts.map((h) => h.hunt_id)).toEqual(['h_run', 'h_done']);
  });

  it('unknown hunt is null', () => {
    expect(huntDetail(db, 'nope', opts)).toBeNull();
  });

  it('scopes each vacancy to the caller', () => {
    const d = huntDetail(db, 'h_done', { ...opts, userId: 'u2' }) as {
      jobs: { company: string; state: string; tracker: unknown }[];
    };
    const byCo = new Map(d.jobs.map((j) => [j.company, j]));
    expect(byCo.get('Theta')!.state).toBe('ready');
    expect(byCo.get('Acme')!.tracker).toBeNull();
  });
});

describe('pipeline hunts — missing tables are null, never 0', () => {
  it('no hunt_live → null list; no hunt_jobs → null vacancies', () => {
    const path = tmpDbPath();
    const w = new Database(path);
    // applications only: every hunt table is missing
    w.exec(
      'CREATE TABLE applications (id TEXT, user_id TEXT, ats_status TEXT, url_norm TEXT, sent TEXT)',
    );
    w.close();
    let db = new Database(path, { readonly: true });
    expect(huntsList(db, opts)).toBeNull();
    expect(huntDetail(db, 'h1', opts)).toBeNull();
    db.close();

    const w2 = new Database(path);
    const huntLiveDdl = HUNTS_SCHEMA_SQL.match(
      /CREATE TABLE hunt_live \([\s\S]*?\);/,
    )![0];
    w2.exec(huntLiveDdl);
    w2.prepare(
      `INSERT INTO hunt_live (hunt_id, "trigger", sources, started_at, step, step_started_at)
       VALUES ('h1', 'scheduled', '[]', '2026-09-27T08:00:00+00:00', 'fetch', '2026-09-27T08:00:00+00:00')`,
    ).run();
    w2.close();
    db = new Database(path, { readonly: true });
    const row = (huntsList(db, opts) as { hunts: Record<string, unknown>[] })
      .hunts[0];
    expect(row.counts).toBeNull();
    expect(row.vacancies).toBeNull();
    expect(row.status).toBe('running');
    const d = huntDetail(db, 'h1', opts)!;
    expect(d.jobs).toBeNull();
    expect(d.per_source).toBeNull();
    db.close();
  });
});

describe('pipeline hunts — rules', () => {
  const now = HUNTS_NOW.getTime();

  it('huntStatus', () => {
    expect(huntStatus({ step: 'waiting', finished_at: null })).toBe('waiting');
    expect(huntStatus({ step: 'fetch', finished_at: null })).toBe('running');
    expect(huntStatus({ step: 'done', finished_at: 'x' })).toBe('done');
    expect(huntStatus({ step: 'error', finished_at: 'x' })).toBe('error');
  });

  it('jobState: duplicate wins, a dash in Sent is declined', () => {
    const applied = (sent: string) => ({ status: 'APPLIED', sent });
    expect(jobState('dup_url', applied(''), null, now)).toBe('duplicate');
    expect(jobState('queued', applied(''), null, now)).toBe('ready');
    expect(jobState('queued', applied('—'), null, now)).toBe('declined');
    expect(jobState('queued', applied('2026-09-27'), null, now)).toBe('sent');
    expect(jobState('queued', applied('EXPIRED'), null, now)).toBe('expired');
    expect(
      jobState(
        'queued',
        { status: 'FAIL', sent: '—' },
        { finished_at: null },
        now,
      ),
    ).toBe('generating');
    expect(jobState('queued', { status: '(blank)', sent: '' }, null, now)).toBe(
      'skipped',
    );
    expect(jobState('applied_inline', null, { finished_at: null }, now)).toBe(
      'generating',
    );
    expect(jobState('card', null, null, now)).toBe('awaiting_decision');
    expect(jobState('new', null, null, now)).toBe('not_acted');
    expect(jobState('queued', null, null, now)).toBe('no_record');
  });
});
