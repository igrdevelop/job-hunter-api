import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildSnapshot,
  eventDetails,
  inferStage,
  refineConfig,
  TrackerSchemaError,
} from './pipeline-snapshot';
import { classifySent, parseSentDate } from './sent-parse';
import { minutesAgo, parseTs, pyRound, SnapshotWindow } from './snapshot-time';
import {
  buildContractDb,
  EXPECTED,
  NOW,
  toApiShape,
} from '../../test/fixtures/pipeline_snapshot/contract';

// Contract fixtures copied from the bot repo (docs/PIPELINE_SNAPSHOT_CONTRACT.md,
// see test/fixtures/pipeline_snapshot/README.md).
const FIXTURE_DIR = join(
  __dirname,
  '..',
  '..',
  'test',
  'fixtures',
  'pipeline_snapshot',
);

function tmpDbPath(prefix: string): string {
  return join(mkdtempSync(join(tmpdir(), prefix)), 'tracker.db');
}

/** Build the contract DB on disk and reopen it read-only (as the service does). */
function contractDb(): { path: string; db: Database.Database } {
  const path = tmpDbPath('pipeline-snap-');
  buildContractDb(path);
  return { path, db: new Database(path, { readonly: true }) };
}

// JSON round-trip so the comparison sees what the HTTP client sees.
const asJson = (v: unknown) => JSON.parse(JSON.stringify(v));

describe('pipeline snapshot — contract fixture', () => {
  let db: Database.Database;
  let path: string;

  beforeAll(() => {
    ({ db, path } = contractDb());
  });
  afterAll(() => db.close());

  it('reproduces the contract expected.json at the frozen NOW', () => {
    const started = performance.now();
    const snap = buildSnapshot(db, {
      days: 1,
      userId: 'u1',
      now: NOW,
      eventsLimit: 10,
      failuresLogPath: join(FIXTURE_DIR, 'does-not-exist.jsonl'),
    });
    const elapsed = performance.now() - started;
    if (elapsed > 200) {
      console.warn(`pipeline snapshot over the fixture took ${elapsed} ms`);
    }
    expect(asJson(snap)).toEqual(toApiShape(EXPECTED));
  });

  it('never writes: the handle is read-only and the file is unchanged', () => {
    const before = readFileSync(path);
    buildSnapshot(db, { days: 7, userId: 'u1', now: NOW });
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(() => db.exec('DELETE FROM applications')).toThrow(/readonly/i);
  });

  it('a 7-day window keeps the 3-day-old hunt and spans 7 Warsaw days', () => {
    const snap = asJson(buildSnapshot(db, { days: 7, userId: 'u1', now: NOW }));
    expect(snap.window).toEqual({
      label: 'last 7 days',
      days: 7,
      start_utc: '2026-09-15T22:00:00+00:00',
      tz: 'Europe/Warsaw',
    });
    expect(snap.hunt.hunt_runs.hunts).toBe(3);
    expect(snap.hunt.hunt_runs.found).toBe(1229);
    expect(snap.hunt.hunt_runs.top_filter_reasons[0]).toEqual([
      'location',
      1109,
    ]);
  });

  it('scopes the apply/result tiers and the events footer to the caller', () => {
    const u1 = asJson(buildSnapshot(db, { days: 1, userId: 'u1', now: NOW }));
    const u2 = asJson(buildSnapshot(db, { days: 1, userId: 'u2', now: NOW }));
    // The hunt tier is global by design — identical for every viewer…
    expect(u2.hunt.hunt_runs).toEqual(u1.hunt.hunt_runs);
    expect(u2.hunt.source_runs).toEqual(u1.hunt.source_runs);
    expect(u2.hunt.postings_seen).toEqual(u1.hunt.postings_seen);
    // …everything else is u2's own: one ready row (x1), none of u1's.
    expect(u2.user_id).toBe('u2');
    expect(u2.hunt.entered_tracker).toEqual({
      rows: 1,
      by_status: { APPLIED: 1 },
      by_source: [['justjoin', 1]],
    });
    expect(u2.apply.pending).toEqual({
      count: 0,
      oldest_date: null,
      oldest_wait_min: null,
      head: [],
    });
    expect(u2.apply.in_progress).toEqual({ count: 0, cards: [] });
    expect(u2.apply.runs.started).toBe(0);
    expect(u2.apply.skipped_rows).toEqual({ count: 0, by_reason: [] });
    expect(u2.apply.failures).toMatchObject({
      in_window: 0,
      retryable_total: 0,
      gave_up_total: 0,
    });
    expect(u2.result.ready).toEqual({
      count: 1,
      produced_in_window: 1,
      mean_verdict: 50,
    });
    expect(u2.events).toEqual([]);
    expect(JSON.stringify(u2)).not.toMatch(/Example Corp|Gamma|Acme/);
  });

  it('parses events[].details from the FULL payload, not the 80-char cut', () => {
    const path = tmpDbPath('pipeline-details-');
    buildContractDb(path);
    const reason = 'r'.repeat(300);
    const payload = JSON.stringify({
      round: 3,
      kind: 'stretch',
      score: 91,
      best: 91,
      reason,
      prompt_tokens: 1234, // unknown telemetry — dropped
    });
    // The tool's display string would be cut here — and is not JSON anymore.
    expect(() => JSON.parse(payload.slice(0, 80))).toThrow();
    const w = new Database(path);
    w.prepare(
      'INSERT INTO pipeline_events (run_id, ts, stage, event, duration_ms, payload) ' +
        'VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      'r_ip',
      '2026-09-22T11:59:30+00:00',
      'refine',
      'accepted',
      1000,
      payload,
    );
    w.prepare(
      'INSERT INTO pipeline_events (run_id, ts, stage, event, duration_ms, payload) ' +
        'VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      'r_ip',
      '2026-09-22T11:59:40+00:00',
      'judge',
      'ok',
      1000,
      '{"foo": 1}',
    );
    w.close();
    const ro = new Database(path, { readonly: true });
    const snap = asJson(buildSnapshot(ro, { days: 1, userId: 'u1', now: NOW }));
    ro.close();
    expect(snap.events[0]).toMatchObject({ stage: 'judge', details: null });
    expect(snap.events[1].details).toEqual({
      round: 3,
      kind: 'stretch',
      score: 91,
      best: 91,
      reason: 'r'.repeat(120),
    });
    expect(snap.events[1].payload).toBeUndefined();
  });

  it('reads apply_failures.jsonl when the path is reachable', () => {
    const logPath = join(
      mkdtempSync(join(tmpdir(), 'pipeline-log-')),
      'apply_failures.jsonl',
    );
    writeFileSync(
      logPath,
      [
        '{"ts": "2026-09-22T10:00:00Z", "outcome": "fail"}',
        '{"ts": "2026-09-22T11:00:00Z", "outcome": "cli_timeout"}',
        '{"ts": "2026-09-22T11:30:00Z", "outcome": "fail"}',
        '{"ts": "2026-09-21T21:59:59Z", "outcome": "fail"}', // before 00:00 Warsaw
        '{"ts": "2026-09-22T11:40:00Z"}',
        'not json',
        '["a list"]',
        '',
      ].join('\n'),
    );
    const snap = asJson(
      buildSnapshot(db, {
        days: 1,
        userId: 'u1',
        now: NOW,
        failuresLogPath: logPath,
      }),
    );
    expect(snap.apply.failures.log_records).toEqual({
      in_window: 4,
      by_outcome: [
        ['fail', 2],
        ['cli_timeout', 1],
        ['?', 1],
      ],
    });
  });
});

describe('pipeline snapshot — degraded schemas', () => {
  // The bot's original applications DDL, before any ALTER-added column
  // (no ats_verdict/claimed_at/claimed_by/outcome_*/skip_reason/source/
  // queued_at) — and no other table at all.
  const BARE = `
    CREATE TABLE applications (
      id TEXT PRIMARY KEY, date TEXT NOT NULL DEFAULT '',
      user_id TEXT NOT NULL DEFAULT '', company TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '', stack TEXT NOT NULL DEFAULT '',
      ats_status TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '',
      url_norm TEXT NOT NULL DEFAULT '', folder TEXT NOT NULL DEFAULT '',
      sent TEXT NOT NULL DEFAULT '', reapplication TEXT NOT NULL DEFAULT '',
      to_learn TEXT NOT NULL DEFAULT '', drive_url TEXT NOT NULL DEFAULT '',
      confirmation TEXT NOT NULL DEFAULT '', answer TEXT NOT NULL DEFAULT '',
      sheets_row INTEGER, sheets_dirty INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL
    );
    INSERT INTO applications (id, date, user_id, company, ats_status, url_norm, sent) VALUES
      ('p1', '2026-09-22', 'u1', 'Acme',  'PENDING',     'ex.com/p1', ''),
      ('ip', '2026-09-22', 'u1', 'Beta',  'IN_PROGRESS', 'ex.com/ip', ''),
      ('a1', '2026-09-22', 'u1', 'Gamma', '94',          'ex.com/a1', ''),
      ('f1', '2026-09-22', 'u1', 'Mu',    'FAIL',        'ex.com/f1', '—');
  `;

  function dbFrom(sql: string): Database.Database {
    const path = tmpDbPath('pipeline-bare-');
    const w = new Database(path);
    w.exec(sql);
    w.close();
    return new Database(path, { readonly: true });
  }

  it('a DB with only an old applications table snapshots with null blocks', () => {
    const db = dbFrom(BARE);
    const snap = asJson(buildSnapshot(db, { days: 1, userId: 'u1', now: NOW }));
    db.close();
    expect(snap.hunt).toEqual({
      hunt_runs: null,
      hunt_runs_unmeasured: 'hunt_runs table missing',
      source_runs: null,
      postings_seen: null,
      entered_tracker: {
        rows: 4,
        by_status: { PENDING: 1, IN_PROGRESS: 1, APPLIED: 1, FAIL: 1 },
        by_source: [['(blank)', 4]],
      },
    });
    expect(snap.apply).toEqual({
      queue_mode_observed: true,
      pending: {
        count: 1,
        oldest_date: '2026-09-22',
        oldest_wait_min: null,
        head: [{ company: 'Acme', title: '', source: '', wait_min: null }],
      },
      in_progress: {
        count: 1,
        cards: [
          {
            company: 'Beta',
            title: '',
            source: '',
            claimed_by: '',
            claimed_min_ago: null,
            stale: false,
            run: null,
          },
        ],
      },
      runs: null,
      skipped_rows: null,
      // No fail_count column: every FAIL row counts as retryable.
      failures: {
        in_window: 1,
        retryable_total: 1,
        gave_up_total: 0,
        log_records: null,
      },
      llm_outage: { paused: false, remaining_min: 0 },
    });
    expect(snap.result).toEqual({
      ready: { count: 1, produced_in_window: 1, mean_verdict: null },
      sent_in_window: 0,
      outcomes_in_window: [],
      cost: {
        total_usd: 0,
        priced_rows: 0,
        unpriced_rows: 1,
        per_priced_row_usd: null,
      },
    });
    expect(snap.events).toBeNull();
  });

  it('a partial hunt_runs / metrics table degrades to null, never throws', () => {
    const db = dbFrom(
      BARE +
        `CREATE TABLE hunt_runs (id INTEGER PRIMARY KEY, ts TEXT, found INTEGER);
         CREATE TABLE generation_runs (run_id TEXT PRIMARY KEY, started_at TEXT);
         CREATE TABLE pipeline_events (id INTEGER PRIMARY KEY, run_id TEXT);
         CREATE TABLE source_runs (id INTEGER PRIMARY KEY, source TEXT);
         CREATE TABLE config (key TEXT PRIMARY KEY);`,
    );
    const snap = asJson(buildSnapshot(db, { days: 1, userId: 'u1', now: NOW }));
    db.close();
    expect(snap.hunt.hunt_runs).toBeNull();
    expect(snap.hunt.hunt_runs_unmeasured).toBe(
      'hunt_runs table lacks columns: applied_inline, capped, dup_cooldown, ' +
        'dup_ct, dup_url, duration_ms, filter_reasons, filtered_out, new, ' +
        'queued, sources, trigger',
    );
    expect(snap.hunt.source_runs).toBeNull();
    expect(snap.apply.runs).toBeNull();
    expect(snap.apply.in_progress.cards[0].run).toBeNull();
    expect(snap.apply.llm_outage).toEqual({ paused: false, remaining_min: 0 });
    expect(snap.events).toBeNull();
  });

  it('no applications table is a schema error, not a crash', () => {
    const db = dbFrom('CREATE TABLE config (key TEXT, value TEXT);');
    expect(() =>
      buildSnapshot(db, { days: 1, userId: 'u1', now: NOW }),
    ).toThrow(TrackerSchemaError);
    db.close();
  });
});

describe('pipeline snapshot — helpers', () => {
  it('computes Warsaw calendar windows across both DST switches', () => {
    // CEST (UTC+2): midnight Warsaw is 22:00 UTC the day before.
    expect(new SnapshotWindow(1, NOW).startIso).toBe(
      '2026-09-21T22:00:00+00:00',
    );
    // 2026-10-25 is the CEST→CET day: it still starts at 22:00 UTC…
    const fallDay = new SnapshotWindow(1, new Date('2026-10-25T20:00:00Z'));
    expect(fallDay.startIso).toBe('2026-10-24T22:00:00+00:00');
    expect(fallDay.dates).toEqual(['2026-10-25']);
    // …and the day after starts at 23:00 UTC (CET, UTC+1).
    const after = new SnapshotWindow(2, new Date('2026-10-26T09:00:00Z'));
    expect(after.startIso).toBe('2026-10-24T22:00:00+00:00');
    expect(after.dates).toEqual(['2026-10-25', '2026-10-26']);
    expect(
      new SnapshotWindow(1, new Date('2026-10-26T09:00:00Z')).startIso,
    ).toBe('2026-10-25T23:00:00+00:00');
    // 23:30 UTC on 2026-09-22 is already 01:30 on the 23rd in Warsaw.
    const lateUtc = new SnapshotWindow(1, new Date('2026-09-22T23:30:00Z'));
    expect(lateUtc.dates).toEqual(['2026-09-23']);
    expect(lateUtc.startIso).toBe('2026-09-22T22:00:00+00:00');
    // Spring forward (2027-03-28): the day after starts at 22:00 UTC again.
    expect(
      new SnapshotWindow(1, new Date('2027-03-29T12:00:00Z')).startIso,
    ).toBe('2027-03-28T22:00:00+00:00');
    expect(
      new SnapshotWindow(1, new Date('2027-03-28T12:00:00Z')).startIso,
    ).toBe('2027-03-27T23:00:00+00:00');
  });

  it('parses the three timestamp shapes the DB holds, null on garbage', () => {
    const utc = Date.parse('2026-09-22T11:46:00Z');
    expect(parseTs('2026-09-22T11:46:00Z')).toBe(utc);
    expect(parseTs('2026-09-22T11:46:00+00:00')).toBe(utc);
    expect(parseTs('2026-09-22T11:46:00')).toBe(utc); // naive → UTC
    expect(parseTs('2026-09-22T13:46:00+02:00')).toBe(utc);
    expect(parseTs('2026-09-22T11:46:00.123456+00:00')).toBe(utc + 123);
    expect(parseTs('2026-02-30T00:00:00')).toBeNull();
    expect(parseTs('yesterday')).toBeNull();
    expect(parseTs('')).toBeNull();
    expect(parseTs(null)).toBeNull();
    expect(parseTs(42)).toBeNull();
    // Clock skew clamps to 0, never negative.
    expect(minutesAgo('2026-09-22T12:30:00Z', NOW.getTime())).toBe(0);
    expect(minutesAgo('2026-09-22T11:45:30Z', NOW.getTime())).toBe(14);
  });

  it("rounds like Python's round() — ties to even", () => {
    expect(pyRound(92.25, 1)).toBe(92.2);
    expect(pyRound(92.75, 1)).toBe(92.8);
    expect(pyRound(0.405, 2)).toBe(0.41); // 0.405 is just above the tie
    expect(pyRound(0.125, 2)).toBe(0.12);
    expect(pyRound(92.3333, 1)).toBe(92.3);
    expect(pyRound(0.81, 2)).toBe(0.81);
    expect(pyRound(-0.125, 2)).toBe(-0.12);
  });

  it('infers the current stage like the tool', () => {
    const ev = (stage: string, event: string) => ({ stage, event });
    expect(inferStage([])).toEqual({ stage: 'fetch', basis: 'no events yet' });
    expect(inferStage([ev('judge', 'start')])).toEqual({
      stage: 'judge',
      basis: 'start event',
    });
    expect(inferStage([ev('refine', 'discarded')])).toEqual({
      stage: 'refine',
      basis: 'refine round discarded',
    });
    expect(inferStage([ev('lang_gate', 'blocked')])).toEqual({
      stage: 'lang_gate',
      basis: 'last event was blocked',
    });
    expect(inferStage([ev('generate', 'ok')])).toEqual({
      stage: 'ats_loop',
      basis: "inferred: after 'generate' ok",
    });
    expect(inferStage([ev('delivery', 'ok')]).stage).toBe('delivery');
    expect(inferStage([ev('mystery', 'ok')]).stage).toBe('?');
  });

  it("reads refine target/max rounds from the run's last refine start", () => {
    const ev = (stage: string, event: string, payload: string | null) => ({
      stage,
      event,
      payload,
    });
    expect(refineConfig([])).toEqual({
      refine_target: null,
      refine_max_rounds: null,
    });
    expect(
      refineConfig([
        ev('refine', 'start', '{"target": 90, "max_rounds": 3}'),
        ev('refine', 'rejected', '{"round": 1}'),
        ev('refine', 'start', '{"target": 95, "max_rounds": 5}'),
        ev('refine', 'accepted', '{"round": 1}'),
      ]),
    ).toEqual({ refine_target: 95, refine_max_rounds: 5 });
    // A start event with a garbage payload is still THE start event.
    expect(
      refineConfig([
        ev('refine', 'start', '{"target": 90, "max_rounds": 3}'),
        ev('refine', 'start', 'not json'),
      ]),
    ).toEqual({ refine_target: null, refine_max_rounds: null });
    expect(refineConfig([ev('verdict', 'start', '{"target": 1}')])).toEqual({
      refine_target: null,
      refine_max_rounds: null,
    });
  });

  it('keeps only the stable event-detail keys', () => {
    expect(eventDetails('')).toBeNull();
    expect(eventDetails(null)).toBeNull();
    expect(eventDetails('not json')).toBeNull();
    expect(eventDetails('[1, 2]')).toBeNull();
    expect(eventDetails('"a string"')).toBeNull();
    expect(eventDetails('{"foo": 1, "bar": "x"}')).toBeNull(); // unknown-only
    expect(eventDetails('{"chars": 5120}')).toEqual({ chars: 5120 });
    expect(eventDetails('{"score": null}')).toEqual({ score: null });
    expect(
      eventDetails(JSON.stringify({ error: 'e'.repeat(250), extra: 1 })),
    ).toEqual({ error: 'e'.repeat(200) });
    // error / reason survive only as strings.
    expect(eventDetails('{"error": {"code": 1}, "reason": 7}')).toBeNull();
    // Cut by code points, like Python's str slice.
    expect(
      eventDetails(JSON.stringify({ reason: '😀'.repeat(130) }))?.reason,
    ).toBe('😀'.repeat(120));
  });

  it('parses the free-text Sent column like hunter/sent_parse.py', () => {
    expect(parseSentDate('2026-07-04 00:00:00', 2026)).toBe('2026-07-04');
    expect(parseSentDate('Zaaplikowano 24.04.2026', 2026)).toBe('2026-04-24');
    expect(parseSentDate('Applied on May 16, 2026', 2026)).toBe('2026-05-16');
    expect(parseSentDate('08 04 26', 2026)).toBe('2026-04-08');
    expect(parseSentDate('15 05', 2026)).toBe('2026-05-15');
    expect(parseSentDate('22 05 (21 05)', 2026)).toBe('2026-05-22');
    expect(parseSentDate('1305', 2026)).toBe('2026-05-13');
    expect(parseSentDate('31 02', 2026)).toBeNull();
    expect(parseSentDate('выгасла 15 05', 2026)).toBeNull();
    expect(classifySent('—', 2026)).toBe('blank');
    expect(classifySent('', 2026)).toBe('blank');
    expect(classifySent('2026-09-22', 2026)).toBe('applied');
    expect(classifySent('EXPIRED', 2026)).toBe('expired');
    expect(classifySent('не тот стек', 2026)).toBe('other');
  });
});
