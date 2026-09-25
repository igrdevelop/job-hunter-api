/**
 * GET /api/pipeline/snapshot — the query layer.
 *
 * A TypeScript port of the bot repo's tools/pipeline_snapshot.py against
 * docs/PIPELINE_SNAPSHOT_CONTRACT.md (docs/PIPELINE_VIZ_PLAN.md M2). The
 * Python tool is the reference: every function below names the tool
 * function it ports, and where this port deliberately differs the comment
 * says so and why.
 *
 * Omitted, per the contract's "Not in the contract" section: `hunt.next_slot`,
 * `hunt.window`, `apply.queue_enabled_local_config`, `apply.failures.next_retry`,
 * the whole `coverage` object, `events[].payload`, and every `at` display
 * string (callers format from the raw `ts`, which `run.last_event` and
 * `run.refine_progress` also carry since contract 5c35447).
 *
 * Read-only by construction: the caller hands in a `readonly` better-sqlite3
 * handle, and every statement here is a SELECT / PRAGMA table_info.
 */
import type Database from 'better-sqlite3';
import { existsSync, readFileSync, statSync } from 'fs';
import { classifySent, parseSentDate } from './sent-parse';
import {
  isoUtcSeconds,
  minutesAgo,
  parseTs,
  pyInt,
  pyRound,
  SNAPSHOT_TZ,
  SnapshotWindow,
  Tally,
} from './snapshot-time';

type Row = Record<string, unknown>;

/** A `pipeline_events` row as the run card reads it. */
interface EventRow {
  ts: string;
  stage: string;
  event: string;
  duration_ms: number | null;
  payload: string | null;
}

// ── Constants pinned by the contract (never read from the bot's .env) ────────

/** `APPLY_CLAIM_TIMEOUT_MIN` default — a claim older than this is stale. */
export const APPLY_CLAIM_TIMEOUT_MIN = 60;
/** `hunter.tracker.MAX_FAIL_RETRIES` (a code constant, not config). */
export const MAX_FAIL_RETRIES = 3;
/** The tool's `--events` default. */
export const DEFAULT_EVENTS_LIMIT = 15;

/** `hunter.hunt_runs.COUNT_COLUMNS`, in DDL order. */
const HUNT_RUN_COUNT_COLUMNS = [
  'found',
  'filtered_out',
  'dup_url',
  'dup_ct',
  'dup_cooldown',
  'new',
  'capped',
  'queued',
  'applied_inline',
  'duration_ms',
] as const;

// The tool's HUNT_RUN_REQUIRED_COLUMNS plus `id`, which its query also
// ORDERs BY (the tool would raise on a table without it; here it's UNMEASURED).
const HUNT_RUN_REQUIRED_COLUMNS = [
  'id',
  'ts',
  'trigger',
  'sources',
  'filter_reasons',
  ...HUNT_RUN_COUNT_COLUMNS,
];

const REFINE_ROUND_EVENTS = ['accepted', 'rejected', 'discarded'];

const ZERO_COST_OUTCOMES = [
  'expired',
  'too_short',
  'skip_react_pre_llm',
  'skip_backend_only',
  'skip_doomed_gate',
  'reused_repost',
  'skip_prescreen',
];

const STAGE_ORDER = [
  'fetch',
  'gates',
  'generate',
  'ats_loop',
  'judge',
  'lang_gate',
  'render',
  'verdict',
  'refine',
  'delivery',
];

// Columns each optional-table query reads. The tool probes only hunt_runs
// this way (and crashes on any other partial table); this port treats a
// table that lacks one of its queried columns exactly like a missing table,
// so a schema drift degrades to `null` instead of a 500.
const SOURCE_RUNS_COLUMNS = ['id', 'source', 'ts', 'yield', 'ok', 'error'];
const POSTINGS_SEEN_COLUMNS = [
  'filter_verdict_last',
  'first_seen',
  'last_seen',
  'source',
];
const GENERATION_RUNS_COLUMNS = [
  'run_id',
  'user_id',
  'url_norm',
  'started_at',
  'finished_at',
  'pipeline',
  'profile',
  'gen_model',
  'outcome',
  'verdict_first',
  'verdict_final',
  'refine_rounds',
  'refine_accepted',
];
const PIPELINE_EVENTS_COLUMNS = [
  'id',
  'run_id',
  'ts',
  'stage',
  'event',
  'duration_ms',
  'payload',
];
const CONFIG_COLUMNS = ['key', 'value'];
/** `hunt_live` — the bot's per-hunt live state (shared contract DDL). */
export const HUNT_LIVE_COLUMNS = [
  'hunt_id',
  'trigger',
  'sources',
  'started_at',
  'step',
  'step_started_at',
  'current_source',
  'sources_done',
  'sources_total',
  'found_so_far',
  'command_id',
  'finished_at',
];
/** The `bot_commands` columns `control.commands` serves. */
const BOT_COMMANDS_COLUMNS = [
  'id',
  'kind',
  'payload',
  'status',
  'error',
  'created_at',
  'started_at',
  'finished_at',
];
/** `control.commands` carries this many newest rows. */
export const CONTROL_COMMANDS_LIMIT = 10;

/** The two `applications` columns without which nothing can be scoped. */
const APPLICATIONS_REQUIRED_COLUMNS = ['user_id', 'ats_status'];

export class TrackerSchemaError extends Error {}

export interface SnapshotOptions {
  days: number;
  userId: string;
  now: Date;
  /** `logs/apply_failures.jsonl`; '' / missing file → `log_records: null`. */
  failuresLogPath?: string;
  eventsLimit?: number;
}

// ── Schema probes ─────────────────────────────────────────────────────────────

class Schema {
  private readonly cache = new Map<string, Set<string>>();

  constructor(private readonly db: Database.Database) {}

  columns(table: string): Set<string> {
    let cols = this.cache.get(table);
    if (!cols) {
      // table_info on a missing table returns no rows — never throws.
      const rows = this.db
        .prepare(`PRAGMA table_info("${table.replace(/"/g, '""')}")`)
        .all() as { name: string }[];
      cols = new Set(rows.map((r) => r.name));
      this.cache.set(table, cols);
    }
    return cols;
  }

  exists(table: string): boolean {
    return this.columns(table).size > 0;
  }

  has(table: string, required: readonly string[]): boolean {
    const cols = this.columns(table);
    return cols.size > 0 && required.every((c) => cols.has(c));
  }

  /** `col` when present, else `<fallback> AS col` (the tool's probe idiom). */
  appCol(col: string, fallback: "''" | 'NULL'): string {
    return this.columns('applications').has(col)
      ? col
      : `${fallback} AS ${col}`;
  }
}

// ── Shared rules ──────────────────────────────────────────────────────────────

/** Port of `_bucket_status`. */
export function bucketStatus(ats: string | null | undefined): string {
  const a = (ats ?? '').trim().toUpperCase();
  if (
    ['PENDING', 'IN_PROGRESS', 'SKIP', 'FAIL', 'MANUAL', 'EXPIRED'].includes(a)
  )
    return a;
  if (['', '—', '–', '-'].includes(a)) return '(blank)';
  return 'APPLIED';
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(',');
}

function parseJson(raw: unknown, fallback: string): unknown {
  try {
    return JSON.parse((raw as string) || fallback);
  } catch {
    return undefined;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ── Hunt tier ─────────────────────────────────────────────────────────────────

/** Port of `_hunt_runs_window`. */
function huntRunsWindow(db: Database.Database, win: SnapshotWindow): Row {
  const countCols = HUNT_RUN_COUNT_COLUMNS.map((c) => `"${c}"`).join(', ');
  const rows = db
    .prepare(
      `SELECT ts, "trigger", sources, filter_reasons, ${countCols} ` +
        'FROM hunt_runs WHERE ts >= ? ORDER BY id',
    )
    .all(win.startIso) as Row[];

  const counts: Record<string, number> = {};
  for (const c of HUNT_RUN_COUNT_COLUMNS) counts[c] = 0;
  const reasons = new Tally();
  const byTrigger = new Tally();
  for (const r of rows) {
    for (const c of HUNT_RUN_COUNT_COLUMNS) counts[c] += pyInt(r[c]);
    byTrigger.add((r.trigger as string) || '?');
    const parsed = parseJson(r.filter_reasons, '{}');
    if (isPlainObject(parsed)) {
      for (const [k, v] of Object.entries(parsed)) {
        try {
          reasons.add(String(k), Math.max(0, pyInt(v)));
        } catch {
          continue; // non-int value: skipped, like the tool
        }
      }
    }
  }
  const totals: Row = { hunts: rows.length, ...counts };
  const last = rows.length ? rows[rows.length - 1] : null;
  if (last) {
    const sources = parseJson(last.sources, '[]');
    totals.last = {
      ts: last.ts,
      trigger: last.trigger,
      sources: Array.isArray(sources) ? sources : [],
      found: pyInt(last.found),
      new: pyInt(last.new),
    };
  } else {
    totals.last = null;
  }
  totals.by_trigger = byTrigger.toObject();
  totals.top_filter_reasons = reasons.mostCommon(8);
  return totals;
}

/** Port of `hunt_tier` (minus `window` and `next_slot`). */
function huntTier(
  db: Database.Database,
  schema: Schema,
  win: SnapshotWindow,
  userId: string,
): Row {
  const out: Row = { hunt_runs: null, hunt_runs_unmeasured: null };

  if (schema.exists('hunt_runs')) {
    const cols = schema.columns('hunt_runs');
    const missing = HUNT_RUN_REQUIRED_COLUMNS.filter(
      (c) => !cols.has(c),
    ).sort();
    if (missing.length) {
      out.hunt_runs_unmeasured = `hunt_runs table lacks columns: ${missing.join(', ')}`;
    } else {
      out.hunt_runs = huntRunsWindow(db, win);
    }
  } else {
    out.hunt_runs_unmeasured = 'hunt_runs table missing';
  }

  // source_runs has no index on ts — it is a per-source ring buffer
  // (SOURCE_HEALTH_KEEP rows per source), so the scan stays small.
  if (schema.has('source_runs', SOURCE_RUNS_COLUMNS)) {
    const rows = db
      .prepare(
        'SELECT source, ts, yield, ok, error FROM source_runs WHERE ts >= ? ORDER BY id',
      )
      .all(win.startIso) as Row[];
    const perSource = new Map<
      string,
      { runs: number; found: number; errors: number; last_ok: boolean | null }
    >();
    for (const r of rows) {
      const key = String(r.source);
      let s = perSource.get(key);
      if (!s) {
        s = { runs: 0, found: 0, errors: 0, last_ok: null };
        perSource.set(key, s);
      }
      s.runs += 1;
      s.found += pyInt(r.yield);
      if (!r.ok) s.errors += 1;
      s.last_ok = Boolean(r.ok);
    }
    const sorted = [...perSource.entries()].sort(
      (a, b) => b[1].found - a[1].found,
    );
    out.source_runs = {
      runs: rows.length,
      found_raw: rows.reduce((acc, r) => acc + pyInt(r.yield), 0),
      sources_ran: perSource.size,
      sources_last_run_ok: [...perSource.values()].filter((s) => s.last_ok)
        .length,
      errors: rows.filter((r) => !r.ok).length,
      per_source: Object.fromEntries(sorted),
    };
  } else {
    out.source_runs = null;
  }

  if (schema.has('postings_seen', POSTINGS_SEEN_COLUMNS)) {
    const seen = db
      .prepare(
        'SELECT filter_verdict_last, first_seen, source FROM postings_seen WHERE last_seen >= ?',
      )
      .all(win.startIso) as Row[];
    const verdict = (r: Row) => (r.filter_verdict_last as string) || '';
    const reasons = new Tally();
    for (const r of seen) {
      if (verdict(r) !== 'passed') {
        reasons.add(verdict(r).split(':')[0] || '(blank)');
      }
    }
    out.postings_seen = {
      unique_seen: seen.length,
      new_this_window: seen.filter(
        (r) => ((r.first_seen as string) || '') >= win.startIso,
      ).length,
      passed: seen.filter((r) => verdict(r) === 'passed').length,
      rejected: seen.filter((r) => verdict(r) !== 'passed').length,
      top_reasons: reasons.mostCommon(8),
    };
  } else {
    out.postings_seen = null;
  }

  // `applications.date` is the calendar day of the WRITING process
  // (`date.today()` in hunter/tracker.py), compared here as set membership
  // over Warsaw day strings — as the contract specifies. Caveat (contract,
  // "Window"): the bot container ran in UTC until TZ=Europe/Warsaw was set
  // on it, so a row written between Warsaw midnight and 01:00/02:00 UTC
  // carries the previous day's date and misses a 1-day window until then.
  const dateExpr = schema.columns('applications').has('date') ? 'date' : "''";
  const rows = db
    .prepare(
      `SELECT ats_status, ${schema.appCol('source', "''")} ` +
        `FROM applications WHERE user_id = ? AND ${dateExpr} IN (${placeholders(win.dates.length)})`,
    )
    .all(userId, ...win.dates) as Row[];
  const byStatus = new Tally();
  const bySource = new Tally();
  for (const r of rows) {
    byStatus.add(bucketStatus(r.ats_status as string));
    bySource.add((r.source as string) || '(blank)');
  }
  out.entered_tracker = {
    rows: rows.length,
    by_status: byStatus.toObject(),
    by_source: bySource.mostCommon(10),
  };
  out.live = huntLive(db, schema);
  out.next = huntNext(db, schema);
  return out;
}

// ── Live hunt state, scheduler facts, control (docs: /pipeline control plan) ──

function scalar(db: Database.Database, sql: string, ...params: unknown[]) {
  const row = db
    .prepare(sql)
    .raw()
    .get(...params) as unknown[] | undefined;
  return row ? row[0] : undefined;
}

/** Map one `hunt_live` row to its contract shape (`sources` parsed). */
function huntLiveRow(r: Row | undefined): Row | null {
  if (!r) return null;
  const sources = parseJson(r.sources, '[]');
  return {
    hunt_id: r.hunt_id,
    trigger: r.trigger,
    sources: Array.isArray(sources) ? sources : [],
    started_at: r.started_at,
    step: r.step,
    step_started_at: r.step_started_at,
    current_source: r.current_source ?? '',
    sources_done: r.sources_done,
    sources_total: r.sources_total,
    found_so_far: r.found_so_far,
    command_id: r.command_id ?? '',
    finished_at: r.finished_at ?? null,
  };
}

/**
 * `hunt.live` = `{active, last}`: `active` is the newest row not yet
 * finished (a hunt waiting for the lock or running), `last` the newest
 * finished one. The bot creates `hunt_live` lazily, so a missing (or
 * partially-migrated) table is `null` — "not measured", never an empty hunt.
 */
function huntLive(db: Database.Database, schema: Schema): Row | null {
  if (!schema.has('hunt_live', HUNT_LIVE_COLUMNS)) return null;
  const cols = HUNT_LIVE_COLUMNS.map((c) => `"${c}"`).join(', ');
  const active = db
    .prepare(
      `SELECT ${cols} FROM hunt_live WHERE finished_at IS NULL
       ORDER BY started_at DESC, rowid DESC LIMIT 1`,
    )
    .get() as Row | undefined;
  const last = db
    .prepare(
      `SELECT ${cols} FROM hunt_live WHERE finished_at IS NOT NULL
       ORDER BY started_at DESC, rowid DESC LIMIT 1`,
    )
    .get() as Row | undefined;
  return { active: huntLiveRow(active), last: huntLiveRow(last) };
}

/**
 * One `config` KV value, JSON-decoded (every `bot_state.*` value is JSON).
 * `undefined` when the key is absent or its value doesn't parse.
 */
function configJson(db: Database.Database, key: string): unknown {
  const raw = scalar(db, 'SELECT value FROM config WHERE key = ?', key);
  if (typeof raw !== 'string' || raw === '') return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * `hunt.next` = `{hunt, retry, updated_at}` from the bot's `bot_state.*`
 * config keys — the scheduler's own `next_t`, written by its 60 s tick.
 * No `config` table ⇒ `null`; a missing/garbled key ⇒ that field `null`.
 * `updated_at` older than 5 min means the bot is offline (the site decides).
 */
function huntNext(db: Database.Database, schema: Schema): Row | null {
  if (!schema.has('config', CONFIG_COLUMNS)) return null;
  const hunt = configJson(db, 'bot_state.next_hunt');
  const retry = configJson(db, 'bot_state.next_retry');
  const updated = configJson(db, 'bot_state.updated_at');
  return {
    hunt: isPlainObject(hunt) ? hunt : null,
    retry: isPlainObject(retry) ? retry : null,
    updated_at: typeof updated === 'string' ? updated : null,
  };
}

/**
 * `bot_state.sources` — the bot's source names (for the per-source hunt
 * buttons and for validating a hunt command). `null` when the `config`
 * table or the key is missing, or the value isn't a list of strings.
 */
export function botSources(
  db: Database.Database,
  schema?: { has(table: string, required: readonly string[]): boolean },
): string[] | null {
  const s = schema ?? new Schema(db);
  if (!s.has('config', CONFIG_COLUMNS)) return null;
  const v = configJson(db, 'bot_state.sources');
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? v : null;
}

/**
 * `control` = `{sources, commands}` — `commands` is the 10 newest
 * `bot_commands` rows (`payload` parsed; `null` for a garbled one), `null`
 * when the table is missing. Global like the hunt tier: commands are
 * owner-only to CREATE, and every one of them acts on the shared bot.
 */
function control(db: Database.Database, schema: Schema): Row {
  let commands: Row[] | null = null;
  if (schema.has('bot_commands', BOT_COMMANDS_COLUMNS)) {
    const rows = db
      .prepare(
        `SELECT id, kind, payload, status, error, created_at, started_at, finished_at
         FROM bot_commands ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      )
      .all(CONTROL_COMMANDS_LIMIT) as Row[];
    commands = rows.map((r) => {
      const payload = parseJson(r.payload, '{}');
      return {
        id: r.id,
        kind: r.kind,
        payload: payload === undefined ? null : payload,
        status: r.status,
        error: (r.error as string) ?? '',
        created_at: r.created_at,
        started_at: r.started_at ?? null,
        finished_at: r.finished_at ?? null,
      };
    });
  }
  return { sources: botSources(db, schema), commands };
}

// ── Apply tier ────────────────────────────────────────────────────────────────

/** Port of `_infer_stage`. */
export function inferStage(events: Pick<EventRow, 'stage' | 'event'>[]): {
  stage: string;
  basis: string;
} {
  if (!events.length) return { stage: 'fetch', basis: 'no events yet' };
  const last = events[events.length - 1];
  if (last.event === 'start') {
    return { stage: last.stage, basis: 'start event' };
  }
  if (last.stage === 'refine' && REFINE_ROUND_EVENTS.includes(last.event)) {
    return { stage: 'refine', basis: `refine round ${last.event}` };
  }
  if (last.event === 'error' || last.event === 'blocked') {
    return { stage: last.stage, basis: `last event was ${last.event}` };
  }
  const i = STAGE_ORDER.indexOf(last.stage);
  const next =
    i < 0
      ? '?'
      : i + 1 < STAGE_ORDER.length
        ? STAGE_ORDER[i + 1]
        : STAGE_ORDER[STAGE_ORDER.length - 1];
  return { stage: next, basis: `inferred: after '${last.stage}' ok` };
}

/** Port of `_stage_started_min_ago`. */
function stageStartedMinAgo(
  events: EventRow[],
  stage: string,
  nowMs: number,
): number | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.event === 'start') {
      return e.stage === stage ? minutesAgo(e.ts, nowMs) : null;
    }
  }
  return null;
}

/** Port of `_refine_progress` (raw `ts` in place of the `at` display). */
function refineProgress(events: EventRow[]): Row | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.stage !== 'refine' || !REFINE_ROUND_EVENTS.includes(e.event)) {
      continue;
    }
    const parsed = parseJson(e.payload, '{}');
    const payload = isPlainObject(parsed) ? parsed : {};
    return {
      round: payload.round ?? null,
      kind: payload.kind ?? null,
      score: payload.score ?? null,
      best: payload.best ?? null,
      outcome: e.event,
      ts: e.ts,
    };
  }
  return null;
}

/**
 * Port of `_refine_config`: `refine_target` / `refine_max_rounds` from THIS
 * run's last `refine`/`start` event payload (`{target, max_rounds,
 * verdict_first}`) — the run's own record of the values it resolved. Both
 * null before the loop starts, when it never runs, or on a pre-M1 run.
 */
export function refineConfig(
  events: Pick<EventRow, 'stage' | 'event' | 'payload'>[],
): {
  refine_target: unknown;
  refine_max_rounds: unknown;
} {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.stage !== 'refine' || e.event !== 'start') continue;
    const parsed = parseJson(e.payload, '{}');
    const payload = isPlainObject(parsed) ? parsed : {};
    return {
      refine_target: payload.target ?? null,
      refine_max_rounds: payload.max_rounds ?? null,
    };
  }
  return { refine_target: null, refine_max_rounds: null };
}

/**
 * Port of `_open_run_for`. Scoped like `apply.runs` (contract "User
 * scoping"): `(user_id = ? OR user_id = '')` — two users can hold the same
 * vacancy (same url_norm), and one user's card must never show the other's run.
 */
function openRunFor(
  db: Database.Database,
  urlNorm: string,
  userId: string,
  nowMs: number,
): Row | null {
  const run = db
    .prepare(
      'SELECT run_id, pipeline, profile, gen_model, started_at, verdict_first, verdict_final, ' +
        'refine_rounds, refine_accepted FROM generation_runs ' +
        "WHERE url_norm = ? AND finished_at IS NULL AND (user_id = ? OR user_id = '') " +
        'ORDER BY started_at DESC LIMIT 1',
    )
    .get(urlNorm, userId) as Row | undefined;
  if (!run) return null;
  const events = db
    .prepare(
      'SELECT ts, stage, event, duration_ms, payload FROM pipeline_events ' +
        'WHERE run_id = ? ORDER BY id',
    )
    .all(run.run_id) as EventRow[];
  const last = events.length ? events[events.length - 1] : null;
  const current = inferStage(events);
  return {
    run_id: run.run_id,
    pipeline: run.pipeline,
    profile: run.profile || run.gen_model,
    elapsed_min: minutesAgo(run.started_at, nowMs),
    events: events.length,
    last_event: last
      ? { stage: last.stage, event: last.event, ts: last.ts }
      : null,
    current_stage: current,
    stage_started_min_ago: stageStartedMinAgo(events, current.stage, nowMs),
    refine_progress: refineProgress(events),
    ...refineConfig(events),
    verdict_first: run.verdict_first,
    verdict_final: run.verdict_final,
    refine_rounds: run.refine_rounds,
    refine_accepted: run.refine_accepted,
  };
}

/** One parsed `apply_failures.jsonl` line: its instant and outcome label. */
interface FailureRecord {
  ts: number | null;
  outcome: string;
}

/**
 * Parsed `apply_failures.jsonl`, keyed by (path, mtimeMs, size). The page
 * polls this endpoint every ~15 s and the bot's RotatingFileHandler lets the
 * live file reach 5 MB (hunter/apply_failures_log.py: maxBytes=5 MB,
 * backupCount=5 — only the live file is read, like the tool), so the file
 * is re-read and re-parsed only when it changed; the window filter still
 * runs per request over the cached records.
 */
let failureLogCache: { key: string; records: FailureRecord[] } | null = null;

function loadFailureLog(path: string): FailureRecord[] | null {
  let key: string;
  try {
    const st = statSync(path);
    key = `${path}|${st.mtimeMs}|${st.size}`;
  } catch {
    return null;
  }
  if (failureLogCache?.key === key) return failureLogCache.records;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const records: FailureRecord[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isPlainObject(rec)) continue;
    records.push({
      ts: parseTs(rec.ts),
      outcome: (rec.outcome as string) || '?',
    });
  }
  failureLogCache = { key, records };
  return records;
}

/** Port of `_failure_log_records`. */
function failureLogRecords(
  path: string | undefined,
  win: SnapshotWindow,
): Row | null {
  if (!path || !existsSync(path)) return null;
  const records = loadFailureLog(path);
  if (records === null) return null;
  const byOutcome = new Tally();
  let total = 0;
  for (const rec of records) {
    if (!win.contains(rec.ts)) continue;
    total += 1;
    byOutcome.add(rec.outcome);
  }
  return { in_window: total, by_outcome: byOutcome.mostCommon() };
}

/** Port of `_llm_outage`. */
function llmOutage(
  db: Database.Database,
  schema: Schema,
  nowMs: number,
): { paused: boolean; remaining_min: number } {
  if (!schema.has('config', CONFIG_COLUMNS)) {
    return { paused: false, remaining_min: 0 };
  }
  const raw = scalar(
    db,
    "SELECT value FROM config WHERE key = 'llm_outage_until'",
  );
  let until = 0;
  if (raw) {
    const n = Number(typeof raw === 'string' ? raw.trim() : raw);
    until = Number.isFinite(n) ? Math.trunc(n) : 0;
  }
  const left = Math.max(0, Math.trunc(until - nowMs / 1000));
  return { paused: left > 0, remaining_min: Math.floor(left / 60) };
}

/** Port of `apply_tier` (minus `queue_enabled_local_config`, `next_retry`). */
function applyTier(
  db: Database.Database,
  schema: Schema,
  win: SnapshotWindow,
  userId: string,
  failuresLogPath: string | undefined,
): Row {
  const cols = schema.columns('applications');
  // Three signals, any one is enough (#293). Signal 2 is NOT user-scoped in
  // the tool either: it answers "is the queue in use", not "is it mine".
  const queueSeen = Boolean(
    (schema.exists('hunt_runs') &&
      schema.columns('hunt_runs').has('queued') &&
      scalar(db, 'SELECT 1 FROM hunt_runs WHERE queued > 0 LIMIT 1')) ||
    scalar(
      db,
      "SELECT 1 FROM applications WHERE ats_status IN ('PENDING','IN_PROGRESS') LIMIT 1",
    ) ||
    (cols.has('claimed_at') &&
      scalar(
        db,
        'SELECT 1 FROM applications WHERE claimed_at IS NOT NULL LIMIT 1',
      )),
  );
  const out: Row = { queue_mode_observed: queueSeen };
  const hasRuns = schema.has('generation_runs', GENERATION_RUNS_COLUMNS);
  const hasMetrics =
    hasRuns && schema.has('pipeline_events', PIPELINE_EVENTS_COLUMNS);
  const c = (col: string, fb: "''" | 'NULL') => schema.appCol(col, fb);

  // PENDING — `rowid` IS the queue order claim_pending drains.
  const pend = db
    .prepare(
      `SELECT ${c('company', "''")}, ${c('title', "''")}, ${c('date', "''")}, rowid, ` +
        `${c('source', "''")}, ${c('queued_at', 'NULL')} ` +
        "FROM applications WHERE user_id = ? AND ats_status = 'PENDING' ORDER BY rowid",
    )
    .all(userId) as Row[];
  out.pending = {
    count: pend.length,
    oldest_date: pend.length ? pend[0].date : null,
    oldest_wait_min: pend.length
      ? minutesAgo(pend[0].queued_at, win.nowMs)
      : null,
    head: pend.slice(0, 5).map((r) => ({
      company: r.company,
      title: r.title,
      source: r.source,
      wait_min: minutesAgo(r.queued_at, win.nowMs),
    })),
  };

  // IN_PROGRESS — one card per row (0 or 1 in practice: one worker).
  const prog = db
    .prepare(
      `SELECT ${c('company', "''")}, ${c('title', "''")}, ${c('url_norm', "''")}, ` +
        `${c('claimed_at', 'NULL')}, ${c('claimed_by', "''")}, ${c('source', "''")} ` +
        "FROM applications WHERE user_id = ? AND ats_status = 'IN_PROGRESS' ORDER BY claimed_at",
    )
    .all(userId) as Row[];
  out.in_progress = {
    count: prog.length,
    cards: prog.map((r) => {
      const mins = minutesAgo(r.claimed_at, win.nowMs);
      return {
        company: r.company,
        title: r.title,
        source: r.source,
        claimed_by: r.claimed_by,
        claimed_min_ago: mins,
        stale: mins !== null && mins > APPLY_CLAIM_TIMEOUT_MIN,
        run:
          hasMetrics && r.url_norm
            ? openRunFor(db, r.url_norm as string, userId, win.nowMs)
            : null,
      };
    }),
  };

  if (hasRuns) {
    const runs = db
      .prepare(
        'SELECT outcome FROM generation_runs ' +
          "WHERE started_at >= ? AND pipeline != 'backfill' AND (user_id = ? OR user_id = '')",
      )
      .all(win.startIso, userId) as Row[];
    const outcomes = new Tally();
    for (const r of runs) outcomes.add((r.outcome as string) || '(open)');
    const cut: Record<string, number> = {};
    for (const k of ZERO_COST_OUTCOMES) {
      if (outcomes.get(k)) cut[k] = outcomes.get(k);
    }
    out.runs = {
      started: runs.length,
      outcomes: outcomes.mostCommon(),
      cut_zero_cost: cut,
      cut_zero_cost_total: ZERO_COST_OUTCOMES.reduce(
        (acc, k) => acc + outcomes.get(k),
        0,
      ),
    };
  } else {
    out.runs = null;
  }

  const dateIn = `date IN (${placeholders(win.dates.length)})`;
  if (cols.has('skip_reason') && cols.has('date')) {
    const sk = db
      .prepare(
        'SELECT ats_status, skip_reason FROM applications ' +
          `WHERE user_id = ? AND ${dateIn} AND ats_status IN ('SKIP','EXPIRED')`,
      )
      .all(userId, ...win.dates) as Row[];
    const prefixes = new Tally();
    for (const r of sk) {
      prefixes.add(
        r.ats_status === 'EXPIRED'
          ? 'EXPIRED'
          : ((r.skip_reason as string) || '').split(':')[0] || '(untagged)',
      );
    }
    out.skipped_rows = { count: sk.length, by_reason: prefixes.mostCommon() };
  } else {
    out.skipped_rows = null;
  }

  // FAIL rows: all time, then split. The tool selects `fail_count`
  // unconditionally (and so dies on a DB without it); probed here.
  const fc = cols.has('fail_count');
  const fails = db
    .prepare(
      `SELECT ${c('date', "''")}, ${c('fail_count', 'NULL')} FROM applications ` +
        "WHERE user_id = ? AND ats_status = 'FAIL'",
    )
    .all(userId) as Row[];
  const dates = new Set(win.dates);
  out.failures = {
    in_window: fails.filter((r) => dates.has(r.date as string)).length,
    retryable_total: fails.filter(
      (r) => !fc || ((r.fail_count as number) || 0) < MAX_FAIL_RETRIES,
    ).length,
    gave_up_total: fails.filter(
      (r) => fc && ((r.fail_count as number) || 0) >= MAX_FAIL_RETRIES,
    ).length,
    log_records: failureLogRecords(failuresLogPath, win),
  };

  out.llm_outage = llmOutage(db, schema, win.nowMs);
  return out;
}

// ── Result tier ───────────────────────────────────────────────────────────────

/** Port of `result_tier`. */
function resultTier(
  db: Database.Database,
  schema: Schema,
  win: SnapshotWindow,
  userId: string,
): Row {
  const sel = [
    schema.appCol('date', "''"),
    'ats_status',
    schema.appCol('sent', "''"),
    schema.appCol('cost_usd', 'NULL'),
    schema.appCol('ats_verdict', 'NULL'),
    schema.appCol('outcome_label', 'NULL'),
    schema.appCol('outcome_at', 'NULL'),
  ];
  const rows = db
    .prepare(`SELECT ${sel.join(', ')} FROM applications WHERE user_id = ?`)
    .all(userId) as Row[];
  const dates = new Set(win.dates);
  const sentOf = (r: Row) => (r.sent as string) || '';

  const applied = rows.filter(
    (r) => bucketStatus(r.ats_status as string) === 'APPLIED',
  );
  const ready = applied.filter((r) => sentOf(r).trim() === '');
  const readyVerdicts = ready
    .filter((r) => r.ats_verdict !== null && r.ats_verdict !== undefined)
    .map((r) => Number(r.ats_verdict));

  const sentInWindow = applied.filter((r) => {
    if (classifySent(sentOf(r), win.localYear) !== 'applied') return false;
    const d = parseSentDate(sentOf(r), win.localYear);
    return d !== null && dates.has(d);
  });

  const outcomes = new Tally();
  for (const r of rows) {
    const label = (r.outcome_label as string) || '';
    if (label && win.contains(parseTs(r.outcome_at))) outcomes.add(label);
  }

  const produced = applied.filter((r) => dates.has(r.date as string));
  // 0.0 is UNPRICED (a CLI-served run), not free — see the contract.
  const costRows = produced.filter(
    (r) =>
      r.cost_usd !== null && r.cost_usd !== undefined && Number(r.cost_usd) > 0,
  );
  const totalCost = pyRound(
    costRows.reduce((acc, r) => acc + Number(r.cost_usd), 0),
    2,
  );

  return {
    ready: {
      count: ready.length,
      produced_in_window: produced.length,
      mean_verdict: readyVerdicts.length
        ? pyRound(
            readyVerdicts.reduce((a, b) => a + b, 0) / readyVerdicts.length,
            1,
          )
        : null,
    },
    sent_in_window: sentInWindow.length,
    outcomes_in_window: outcomes.mostCommon(),
    cost: {
      total_usd: totalCost,
      priced_rows: costRows.length,
      unpriced_rows: produced.length - costRows.length,
      per_priced_row_usd: costRows.length
        ? pyRound(totalCost / costRows.length, 2)
        : null,
    },
  };
}

// ── Events footer ─────────────────────────────────────────────────────────────

/** Payload keys passed through as-is (`EVENT_DETAIL_KEYS`). */
const EVENT_DETAIL_KEYS = [
  'round',
  'kind',
  'score',
  'best',
  'target',
  'max_rounds',
  'verdict_first',
  'chars',
];
/** Free-text payload keys, cut to a fixed length (`EVENT_DETAIL_TEXT_KEYS`). */
const EVENT_DETAIL_TEXT_KEYS: [string, number][] = [
  ['error', 200],
  ['reason', 120],
];

/**
 * Port of `_event_details`: the stable fields of the FULL
 * `pipeline_events.payload` column (never the tool's 80-char `payload`
 * display string — a refine round carrying `reason` is broken JSON after
 * that cut). null for an empty / unparseable / non-object payload, or one
 * carrying none of the known keys. `error`/`reason` are kept only when they
 * are strings, cut by code points like Python's slice.
 */
export function eventDetails(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== 'string') return null;
  let data: unknown;
  try {
    data = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!isPlainObject(data)) return null;
  const out: Record<string, unknown> = {};
  for (const k of EVENT_DETAIL_KEYS) {
    if (Object.prototype.hasOwnProperty.call(data, k)) out[k] = data[k];
  }
  for (const [k, cap] of EVENT_DETAIL_TEXT_KEYS) {
    const v = data[k];
    if (typeof v === 'string') out[k] = Array.from(v).slice(0, cap).join('');
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Port of `recent_events` (minus `at` and the 80-char `payload` display
 * string — still "Not in the contract"; `details` is its parsed replacement).
 *
 * Scoped per the contract's "User scoping" section: runs by
 * `(r.user_id = ? OR r.user_id = '')`, the company lookup by
 * `a.user_id = ?` and skipping a blank `r.url_norm` (a paste-mode run). The
 * extra `a.url_norm != ''` is implied by those two and only lets SQLite use
 * the partial idx_user_url_norm. The ORDER BY uses idx_pipeline_events_ts
 * (bot metrics.py since 5c35447) where the bot has created it.
 */
function recentEvents(
  db: Database.Database,
  schema: Schema,
  userId: string,
  limit: number,
): Row[] | null {
  if (
    !schema.has('pipeline_events', PIPELINE_EVENTS_COLUMNS) ||
    !schema.has('generation_runs', GENERATION_RUNS_COLUMNS)
  ) {
    return null;
  }
  const company = schema.columns('applications').has('url_norm')
    ? "(SELECT company FROM applications a WHERE a.url_norm = r.url_norm AND r.url_norm != '' AND a.user_id = ? AND a.url_norm != '' LIMIT 1)"
    : "(SELECT '' WHERE ? IS NOT NULL)";
  const rows = db
    .prepare(
      `SELECT e.ts, e.stage, e.event, e.duration_ms, e.payload, r.pipeline, ${company} AS company
       FROM pipeline_events e
       JOIN generation_runs r ON r.run_id = e.run_id
       WHERE (r.user_id = ? OR r.user_id = '')
       ORDER BY e.ts DESC, e.id DESC LIMIT ?`,
    )
    .all(userId, userId, limit) as Row[];
  return rows.map((r) => ({
    ts: r.ts,
    stage: r.stage,
    event: r.event,
    duration_ms: r.duration_ms,
    company: (r.company as string) || '',
    pipeline: r.pipeline,
    details: eventDetails(r.payload),
  }));
}

// ── Snapshot ──────────────────────────────────────────────────────────────────

/**
 * Port of `build_snapshot`. `db` must be a read-only handle; everything runs
 * inside ONE read transaction so the tiers describe the same instant (the
 * tool reads them statement by statement).
 */
export function buildSnapshot(
  db: Database.Database,
  opts: SnapshotOptions,
): Row {
  const schema = new Schema(db);
  if (!schema.exists('applications')) {
    throw new TrackerSchemaError(
      'tracker.db has no applications table — not a tracker.db',
    );
  }
  const appCols = schema.columns('applications');
  const missing = APPLICATIONS_REQUIRED_COLUMNS.filter((c) => !appCols.has(c));
  if (missing.length) {
    throw new TrackerSchemaError(
      `applications table lacks columns: ${missing.join(', ')}`,
    );
  }

  const win = new SnapshotWindow(opts.days, opts.now);
  const read = db.transaction(() => ({
    generated_at: isoUtcSeconds(win.nowMs),
    window: {
      label: win.label,
      days: win.days,
      start_utc: win.startIso,
      tz: SNAPSHOT_TZ,
    },
    user_id: opts.userId || '(unscoped: empty user_id)',
    hunt: huntTier(db, schema, win, opts.userId),
    apply: applyTier(db, schema, win, opts.userId, opts.failuresLogPath),
    result: resultTier(db, schema, win, opts.userId),
    events: recentEvents(
      db,
      schema,
      opts.userId,
      opts.eventsLimit ?? DEFAULT_EVENTS_LIMIT,
    ),
    control: control(db, schema),
  }));
  return read();
}
