/**
 * Time + number helpers for the pipeline snapshot port.
 *
 * Source of truth: the bot repo's tools/pipeline_snapshot.py (reference
 * implementation of docs/PIPELINE_SNAPSHOT_CONTRACT.md). Every helper here
 * mirrors one Python helper of that file, named in its comment, so a reader
 * can diff the two side by side.
 */

export const SNAPSHOT_TZ = 'Europe/Warsaw';

const MINUTE_MS = 60_000;

/** A `{year, month (1-12), day}` calendar date, no time zone attached. */
interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

const WARSAW_PARTS = new Intl.DateTimeFormat('en-CA', {
  timeZone: SNAPSHOT_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** Wall-clock fields of `ms` in Europe/Warsaw, whatever the process TZ is. */
function warsawWallClock(ms: number): CalendarDate & {
  hour: number;
  minute: number;
  second: number;
} {
  const parts: Record<string, number> = {};
  for (const p of WARSAW_PARTS.formatToParts(new Date(ms))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
}

/** Warsaw UTC offset (ms) at the instant `ms`. */
function warsawOffsetMs(ms: number): number {
  const w = warsawWallClock(ms);
  const asUtc = Date.UTC(
    w.year,
    w.month - 1,
    w.day,
    w.hour,
    w.minute,
    w.second,
  );
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** UTC instant of 00:00 Warsaw on the given calendar day (DST-correct). */
function warsawMidnightUtc(d: CalendarDate): number {
  const naive = Date.UTC(d.year, d.month - 1, d.day);
  const first = naive - warsawOffsetMs(naive);
  const second = warsawOffsetMs(first);
  return naive - second;
}

/** Calendar arithmetic on a plain date (no zone involved). */
function addDays(d: CalendarDate, n: number): CalendarDate {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day + n));
  return {
    year: t.getUTCFullYear(),
    month: t.getUTCMonth() + 1,
    day: t.getUTCDate(),
  };
}

function ymd(d: CalendarDate): string {
  return `${String(d.year).padStart(4, '0')}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
}

/** Python `dt.astimezone(timezone.utc).isoformat(timespec="seconds")`. */
export function isoUtcSeconds(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19) + '+00:00';
}

/**
 * Port of `Window` — N Warsaw calendar days ending today.
 *
 * Computed explicitly in Europe/Warsaw via Intl, never from the process TZ:
 * the API container's own TZ is irrelevant here.
 */
export class SnapshotWindow {
  readonly nowMs: number;
  readonly days: number;
  readonly startMs: number;
  readonly startIso: string;
  /** The N local calendar days as YYYY-MM-DD (for `applications.date`). */
  readonly dates: string[];
  readonly label: string;
  /** Warsaw calendar year of `now` (sent-parse's default year). */
  readonly localYear: number;

  constructor(days: number, now: Date) {
    this.nowMs = now.getTime();
    this.days = days;
    const local = warsawWallClock(this.nowMs);
    this.localYear = local.year;
    const startDay = addDays(local, -(days - 1));
    this.startMs = warsawMidnightUtc(startDay);
    this.startIso = isoUtcSeconds(this.startMs);
    this.dates = Array.from({ length: days }, (_, i) =>
      ymd(addDays(startDay, i)),
    );
    this.label = days === 1 ? 'today' : `last ${days} days`;
  }

  /** Port of `Window.contains`: parsed instant is at/after the start. */
  contains(ms: number | null): boolean {
    return ms !== null && ms >= this.startMs;
  }
}

// Python 3.11 `datetime.fromisoformat` over the shapes the bot writes:
// `…+00:00`, `…Z` (pre-converted below) and a naive ISO string. Date-only,
// hour-only and fractional seconds are accepted like Python does.
const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2})(?::?(\d{2})(?::?(\d{2})(?:[.,](\d{1,6}))?)?)?)?(?:([+-])(\d{2}):?(\d{2})(?::?(\d{2}))?)?$/;

/**
 * Port of `_parse_ts`: tolerant UTC parser. Returns epoch ms, or null for a
 * non-string / blank / unparseable value. A naive string is treated as UTC.
 */
export function parseTs(value: unknown): number | null {
  if (!value || typeof value !== 'string') return null;
  let v = value.trim();
  if (v.endsWith('Z')) v = v.slice(0, -1) + '+00:00';
  const m = ISO_RE.exec(v);
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const hour = m[4] ? Number(m[4]) : 0;
  const minute = m[5] ? Number(m[5]) : 0;
  const second = m[6] ? Number(m[6]) : 0;
  const micros = m[7] ? Number(m[7].padEnd(6, '0')) : 0;
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) {
    return null;
  }
  const base = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(base);
  if (check.getUTCDate() !== day || check.getUTCMonth() !== month - 1) {
    return null; // e.g. 2026-02-30
  }
  let offsetMs = 0;
  if (m[8]) {
    const sign = m[8] === '-' ? -1 : 1;
    offsetMs =
      sign *
      ((Number(m[9]) * 60 + Number(m[10])) * MINUTE_MS +
        (m[11] ? Number(m[11]) * 1000 : 0));
  }
  return base + Math.floor(micros / 1000) - offsetMs;
}

/** Port of `_minutes_ago`: floor minutes since `value`, clamped at 0. */
export function minutesAgo(value: unknown, nowMs: number): number | null {
  const t = parseTs(value);
  if (t === null) return null;
  return Math.max(0, Math.floor((nowMs - t) / MINUTE_MS));
}

/**
 * Python's `round(x, nd)` — correctly rounded, ties to EVEN on an exact
 * binary tie (JS `toFixed` rounds exact ties away from zero, so 92.25 would
 * read 92.3 here but 92.2 in the bot's tool).
 */
export function pyRound(x: number, nd: number): number {
  if (!Number.isFinite(x)) return x;
  const sign = x < 0 ? -1 : 1;
  const abs = Math.abs(x);
  const exact = abs.toFixed(100); // exact decimal expansion for these magnitudes
  const dot = exact.indexOf('.');
  const tail = exact.slice(dot + 1 + nd);
  const isTie = tail[0] === '5' && /^0*$/.test(tail.slice(1));
  if (isTie) {
    const down = exact.slice(0, nd > 0 ? dot + 1 + nd : dot);
    const lastDigit = Number(down.replace('.', '').slice(-1));
    if (lastDigit % 2 === 0) return sign * Number(down);
  }
  return sign * Number(abs.toFixed(nd));
}

/**
 * Python `int(v)` as used by the tool's `int(r[c] or 0)` / `int(v or 0)`:
 * truncation toward zero; throws on something `int()` would reject.
 */
export function pyInt(v: unknown): number {
  if (v === null || v === undefined || v === false || v === '' || v === 0) {
    return 0;
  }
  if (v === true) return 1;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new TypeError('non-finite');
    return Math.trunc(v);
  }
  if (typeof v === 'string' && /^\s*[+-]?\d+(?:_\d+)*\s*$/.test(v)) {
    return Number(v.replace(/_/g, '').trim());
  }
  throw new TypeError(`int() cannot convert ${typeof v}`);
}

/**
 * `collections.Counter` subset: insertion-ordered counts and a stable
 * `most_common()` (ties keep first-seen order, like Python's).
 */
export class Tally {
  private readonly counts = new Map<string, number>();

  add(key: string, n = 1): void {
    this.counts.set(key, (this.counts.get(key) ?? 0) + n);
  }

  get(key: string): number {
    return this.counts.get(key) ?? 0;
  }

  /** Array of `[label, count]` pairs, count desc (JSON has no tuple). */
  mostCommon(limit?: number): [string, number][] {
    const pairs = [...this.counts.entries()].sort((a, b) => b[1] - a[1]);
    return limit === undefined ? pairs : pairs.slice(0, limit);
  }

  toObject(): Record<string, number> {
    return Object.fromEntries(this.counts);
  }
}
