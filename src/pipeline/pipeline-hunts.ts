/**
 * GET /api/pipeline/hunts and GET /api/pipeline/hunts/:huntId — the hunts
 * table on the /pipeline page and one hunt's drill-down.
 *
 * A TypeScript port of `hunts_list` / `hunt_detail` in the bot repo's
 * tools/pipeline_snapshot.py, against the "Hunts table + one hunt's
 * drill-down" section of its docs/PIPELINE_SNAPSHOT_CONTRACT.md
 * (docs/HUNT_DRILLDOWN_PLAN.md M2 there). The Python tool is the reference;
 * each function names the one it ports. Omitted, as in the snapshot port:
 * every `at` display string (callers format from the raw `ts`).
 *
 * Read-only by construction: every statement is a SELECT / PRAGMA table_info
 * over the caller's `readonly` handle. A missing table or column is `null`,
 * never 0 — the bot creates `hunt_live` / `hunt_runs` / `hunt_jobs` lazily.
 */
import type Database from 'better-sqlite3';
import {
  bucketStatus,
  HUNT_LIVE_COLUMNS,
  HUNT_RUN_COUNT_COLUMNS,
  huntLiveRow,
  isPlainObject,
  openRunFor,
  parseJson,
  placeholders,
  Schema,
  TrackerSchemaError,
} from './pipeline-snapshot';
import { classifySent } from './sent-parse';
import { minutesAgo, parseTs, SnapshotWindow } from './snapshot-time';

type Row = Record<string, unknown>;

/** `hunter.hunt_jobs.DUP_FATES`. */
const DUP_FATES = ['dup_url', 'dup_ct', 'dup_cooldown'];

/** `HUNT_JOB_STATES`, in the order `by_state` lists them. */
export const HUNT_JOB_STATES = [
  'generating',
  'queued',
  'ready',
  'sent',
  'declined',
  'skipped',
  'failed',
  'expired',
  'manual',
  'awaiting_decision',
  'capped',
  'not_acted',
  'no_record',
  'duplicate',
] as const;

const HUNT_JOB_FIELDS = [
  'url',
  'url_norm',
  'source',
  'title',
  'company',
  'fate',
  'fate_detail',
];

/** `HUNT_JOB_TRACKER_OPTIONAL` — `applications` columns served when present. */
const TRACKER_OPTIONAL = [
  'skip_reason',
  'folder',
  'drive_url',
  'ats_verdict',
  'cost_usd',
  'queued_at',
];

const GENERATION_RUN_COLUMNS = [
  'run_id',
  'user_id',
  'url_norm',
  'started_at',
  'finished_at',
  'pipeline',
  'outcome',
  'verdict_first',
  'verdict_final',
  'refine_rounds',
];

export const DEFAULT_HUNTS_LIMIT = 50;

interface JobRow {
  hunt_id: string;
  url: string;
  url_norm: string;
  source: string;
  title: string;
  company: string;
  fate: string;
  fate_detail: string;
}

interface HuntCounts {
  counts: Record<string, number>;
  filter_reasons: [string, number][];
  per_source: Record<string, unknown>;
}

const intOr0 = (v: unknown): number => Math.trunc(Number(v) || 0);

/** Python's default str ordering (codepoints), for tie-breaks. */
const byCodepoint = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;

/** Port of `_hunt_status`. */
export function huntStatus(live: Row): string {
  if (live.finished_at) return live.step === 'error' ? 'error' : 'done';
  return live.step === 'waiting' ? 'waiting' : 'running';
}

/** Port of `_hunt_counts`: hunt_id → counts, or null without the columns. */
function huntCounts(
  db: Database.Database,
  schema: Schema,
  huntIds: string[],
): Map<string, HuntCounts> | null {
  if (
    !schema.has('hunt_runs', [
      'id',
      'hunt_id',
      'filter_reasons',
      ...HUNT_RUN_COUNT_COLUMNS,
    ])
  ) {
    return null;
  }
  const out = new Map<string, HuntCounts>();
  if (!huntIds.length) return out;
  const perSource = schema.columns('hunt_runs').has('per_source')
    ? 'per_source'
    : "'{}' AS per_source";
  const countCols = HUNT_RUN_COUNT_COLUMNS.map((c) => `"${c}"`).join(', ');
  const rows = db
    .prepare(
      `SELECT hunt_id, ${countCols}, filter_reasons, ${perSource} FROM hunt_runs
       WHERE hunt_id IN (${placeholders(huntIds.length)}) ORDER BY id`,
    )
    .all(...huntIds) as Row[];
  for (const r of rows) {
    const reasons = parseJson(r.filter_reasons, '{}');
    const ps = parseJson(r.per_source, '{}');
    const counts: Record<string, number> = {};
    for (const c of HUNT_RUN_COUNT_COLUMNS) counts[c] = intOr0(r[c]);
    out.set(r.hunt_id as string, {
      counts,
      filter_reasons: isPlainObject(reasons)
        ? Object.entries(reasons)
            .map(([k, v]): [string, number] => [String(k), intOr0(v)])
            .sort((a, b) => b[1] - a[1] || byCodepoint(a[0], b[0]))
        : [],
      per_source: isPlainObject(ps) ? ps : {},
    });
  }
  return out;
}

/** Port of `_hunt_job_rows`: null when `hunt_jobs` is missing. */
function huntJobRows(
  db: Database.Database,
  schema: Schema,
  huntIds: string[],
): JobRow[] | null {
  if (!schema.has('hunt_jobs', ['id', 'hunt_id', ...HUNT_JOB_FIELDS])) {
    return null;
  }
  if (!huntIds.length) return [];
  return db
    .prepare(
      `SELECT hunt_id, ${HUNT_JOB_FIELDS.join(', ')} FROM hunt_jobs
       WHERE hunt_id IN (${placeholders(huntIds.length)}) ORDER BY id`,
    )
    .all(...huntIds) as JobRow[];
}

/** Port of `_tracker_rows_for`: url_norm → the user's current row. */
function trackerRowsFor(
  db: Database.Database,
  schema: Schema,
  urlNorms: Set<string>,
  userId: string,
  nowMs: number,
): Map<string, Row> {
  const out = new Map<string, Row>();
  const keys = [...urlNorms].filter(Boolean).sort(byCodepoint);
  if (!keys.length) return out;
  // The API always has `applications` (TrackerService migrates it): a table
  // missing these columns is a broken tracker.db, not "no tracker rows" —
  // 503 like the snapshot, never a 200 that labels every vacancy wrongly.
  // (The bot's dev-only tool returns no rows here instead.)
  if (
    !schema.has('applications', ['url_norm', 'ats_status', 'sent', 'user_id'])
  ) {
    throw new TrackerSchemaError(
      'applications table lacks the columns the hunt drill-down reads',
    );
  }
  const cols = schema.columns('applications');
  const extra = TRACKER_OPTIONAL.filter((c) => cols.has(c));
  const select = ['url_norm', 'ats_status', 'sent', 'rowid', ...extra].join(
    ', ',
  );
  const rows = db
    .prepare(
      `SELECT ${select} FROM applications
       WHERE user_id = ? AND url_norm IN (${placeholders(keys.length)}) ORDER BY rowid`,
    )
    .all(userId, ...keys) as Row[];
  const pending = db
    .prepare(
      "SELECT rowid FROM applications WHERE user_id = ? AND ats_status = 'PENDING' ORDER BY rowid",
    )
    .raw()
    .all(userId) as unknown[][];
  const position = new Map<unknown, number>();
  pending.forEach((r, i) => position.set(r[0], i + 1));
  for (const r of rows) {
    // ascending rowid: the newest row per url_norm wins
    const status = bucketStatus(r.ats_status as string | null);
    const isPending = status === 'PENDING';
    const block: Row = {
      status,
      sent: r.sent || '',
      queue_position: isPending ? (position.get(r.rowid) ?? null) : null,
    };
    for (const c of TRACKER_OPTIONAL) {
      if (c !== 'queued_at') block[c] = extra.includes(c) ? r[c] : null;
    }
    block.wait_min =
      isPending && extra.includes('queued_at')
        ? minutesAgo(r.queued_at, nowMs)
        : null;
    out.set(r.url_norm as string, block);
  }
  return out;
}

/** Port of `_runs_for`: url_norm → the newest non-backfill run. */
function runsFor(
  db: Database.Database,
  schema: Schema,
  urlNorms: Set<string>,
  userId: string,
  nowMs: number,
): Map<string, Row> {
  const out = new Map<string, Row>();
  const keys = [...urlNorms].filter(Boolean).sort(byCodepoint);
  if (!keys.length || !schema.has('generation_runs', GENERATION_RUN_COLUMNS)) {
    return out;
  }
  const cost = schema.columns('generation_runs').has('cost_usd')
    ? 'cost_usd'
    : 'NULL AS cost_usd';
  const rows = db
    .prepare(
      `SELECT run_id, url_norm, pipeline, started_at, finished_at, outcome,
              verdict_first, verdict_final, refine_rounds, ${cost}
       FROM generation_runs
       WHERE url_norm IN (${placeholders(keys.length)}) AND pipeline != 'backfill'
         AND (user_id = ? OR user_id = '')
       ORDER BY started_at, rowid`,
    )
    .all(...keys, userId) as Row[];
  for (const r of rows) {
    // ascending start: the newest run per url_norm wins
    out.set(r.url_norm as string, {
      run_id: r.run_id,
      pipeline: r.pipeline,
      started_at: r.started_at,
      finished_at: r.finished_at ?? null,
      outcome: r.outcome ?? null,
      verdict_first: r.verdict_first ?? null,
      verdict_final: r.verdict_final ?? null,
      refine_rounds: r.refine_rounds ?? null,
      cost_usd: r.cost_usd ?? null,
      live: null,
    });
  }
  if (schema.exists('pipeline_events')) {
    for (const [key, run] of out) {
      if (run.finished_at === null) {
        run.live = openRunFor(db, key, userId, nowMs);
      }
    }
  }
  return out;
}

/** Port of `_job_state`: where one vacancy of a hunt is NOW. */
export function jobState(
  fate: string,
  tracker: Row | null,
  run: Row | null,
  nowMs: number,
): string {
  if (DUP_FATES.includes(fate)) return 'duplicate';
  const runOpen = !!run && run.finished_at === null;
  if (tracker) {
    const status = tracker.status as string;
    if (status === 'PENDING') return 'queued';
    if (status === 'IN_PROGRESS') return 'generating';
    // A retry / manual re-run of a FAIL or SKIP row keeps that row until it
    // ends: the open run is the truth while it lasts.
    if (runOpen) return 'generating';
    if (status === 'APPLIED') {
      // Only an EMPTY Sent is waiting to be sent; a dash is the owner
      // declining by hand, EXPIRED the nightly expiry sweep.
      const sent = ((tracker.sent as string) || '').trim();
      if (!sent) return 'ready';
      // The Warsaw calendar year, as the result tier passes it.
      const year = new SnapshotWindow(1, new Date(nowMs)).localYear;
      const kind = classifySent(sent, year);
      if (kind === 'applied') return 'sent';
      return kind === 'expired' ? 'expired' : 'declined';
    }
    if (status === 'FAIL') return 'failed';
    if (status === 'EXPIRED') return 'expired';
    if (status === 'MANUAL') return 'manual';
    return 'skipped';
  }
  if (runOpen) return 'generating';
  if (fate === 'card') return 'awaiting_decision';
  if (fate === 'capped') return 'capped';
  if (fate === 'new') return 'not_acted';
  return 'no_record';
}

function resolveJobs(
  db: Database.Database,
  schema: Schema,
  rows: JobRow[],
  userId: string,
  nowMs: number,
): Row[] {
  const keys = new Set(rows.map((r) => r.url_norm));
  const trackers = trackerRowsFor(db, schema, keys, userId, nowMs);
  const runs = runsFor(db, schema, keys, userId, nowMs);
  return rows.map((r) => {
    const job: Row = { hunt_id: r.hunt_id };
    for (const f of HUNT_JOB_FIELDS) job[f] = r[f as keyof JobRow];
    job.tracker = trackers.get(r.url_norm) ?? null;
    job.run = runs.get(r.url_norm) ?? null;
    job.state = jobState(
      r.fate,
      job.tracker as Row | null,
      job.run as Row | null,
      nowMs,
    );
    return job;
  });
}

/** Port of `_vacancy_summary`. */
function vacancySummary(jobs: Row[]): Row {
  const tally = new Map<string, number>();
  for (const j of jobs) {
    tally.set(j.state as string, (tally.get(j.state as string) ?? 0) + 1);
  }
  const byState: Record<string, number> = {};
  for (const s of HUNT_JOB_STATES) {
    const n = tally.get(s);
    if (n) byState[s] = n;
  }
  return { total: jobs.length, by_state: byState };
}

/** Port of `_hunt_row`. */
function huntRow(live: Row, counts: HuntCounts | undefined): Row {
  const started = parseTs(live.started_at);
  const finished = parseTs(live.finished_at);
  return {
    ...live,
    status: huntStatus(live),
    duration_sec:
      started !== null && finished !== null
        ? Math.trunc((finished - started) / 1000)
        : null,
    counts: counts ? counts.counts : null,
  };
}

/** Port of `hunts_list` → `{hunts}`, or null without `hunt_live`. */
export function huntsList(
  db: Database.Database,
  opts: { userId: string; now: Date; limit?: number },
): Row | null {
  const schema = new Schema(db);
  if (!schema.has('hunt_live', HUNT_LIVE_COLUMNS)) return null;
  const nowMs = opts.now.getTime();
  const limit = Math.max(1, Math.trunc(opts.limit ?? DEFAULT_HUNTS_LIMIT));
  const cols = HUNT_LIVE_COLUMNS.map((c) => `"${c}"`).join(', ');
  const read = db.transaction(() => {
    const lives = (
      db
        .prepare(
          `SELECT ${cols} FROM hunt_live ORDER BY started_at DESC, rowid DESC LIMIT ?`,
        )
        .all(limit) as Row[]
    ).map((r) => huntLiveRow(r)!);
    const ids = lives.map((l) => l.hunt_id as string);
    const counts = huntCounts(db, schema, ids);
    const jobRows = huntJobRows(db, schema, ids);
    const jobsByHunt = new Map<string, Row[]>();
    if (jobRows) {
      for (const job of resolveJobs(db, schema, jobRows, opts.userId, nowMs)) {
        const list = jobsByHunt.get(job.hunt_id as string) ?? [];
        list.push(job);
        jobsByHunt.set(job.hunt_id as string, list);
      }
    }
    return {
      hunts: lives.map((live) => ({
        ...huntRow(live, counts?.get(live.hunt_id as string)),
        vacancies:
          jobRows === null
            ? null
            : vacancySummary(jobsByHunt.get(live.hunt_id as string) ?? []),
      })),
    };
  });
  return read();
}

/** Port of `hunt_detail`, or null when neither table knows the hunt. */
export function huntDetail(
  db: Database.Database,
  huntId: string,
  opts: { userId: string; now: Date },
): Row | null {
  const schema = new Schema(db);
  const nowMs = opts.now.getTime();
  const read = db.transaction(() => {
    let live: Row | null = null;
    if (schema.has('hunt_live', HUNT_LIVE_COLUMNS)) {
      const cols = HUNT_LIVE_COLUMNS.map((c) => `"${c}"`).join(', ');
      live = huntLiveRow(
        db
          .prepare(`SELECT ${cols} FROM hunt_live WHERE hunt_id = ?`)
          .get(huntId) as Row | undefined,
      );
    }
    const counts = huntCounts(db, schema, [huntId])?.get(huntId);
    if (live === null && !counts) return null;
    const synthesized = live === null;
    if (live === null) {
      // the hunt_live ring already dropped it; hunt_runs still has it
      live = Object.fromEntries(HUNT_LIVE_COLUMNS.map((c) => [c, null]));
      Object.assign(live, { hunt_id: huntId, sources: [], step: 'done' });
    }
    const jobRows = huntJobRows(db, schema, [huntId]);
    const jobs =
      jobRows === null
        ? null
        : resolveJobs(db, schema, jobRows, opts.userId, nowMs).map((j) => {
            delete j.hunt_id; // the detail is one hunt: the key is redundant
            return j;
          });
    const hunt = huntRow(live, counts);
    if (synthesized) hunt.status = 'done';
    return {
      hunt,
      per_source: counts ? counts.per_source : null,
      filter_reasons: counts ? counts.filter_reasons : null,
      vacancies: jobs === null ? null : vacancySummary(jobs),
      jobs,
    };
  });
  return read();
}
