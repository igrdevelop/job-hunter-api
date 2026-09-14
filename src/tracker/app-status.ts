// Web-only "My Status" dropdown (appStatus column) and its derivation onto
// the bot-owned sent/outcome_label/outcome_at columns.
// Source of truth for this mapping: docs plan "Applications table: My Status
// drives Sent, Note column, instant refresh" (approved 2026-09-14). Keep the
// option list identical (including order) to job-hunter-site's
// APP_STATUS_OPTIONS.
export const APP_STATUS_OPTIONS = [
  '',
  'Sent',
  'Interview',
  'Rejected',
  'Offer',
  'Silence',
  'Skipped',
  'Filter miss',
] as const;
export type AppStatus = (typeof APP_STATUS_OPTIONS)[number];

// Statuses that mean "I applied" — derive an ISO sent date when sent is
// still blank/dash, and (for the four with a matching bot outcome label)
// derive outcome_label/outcome_at.
export const APPLIED_STATUSES = [
  'Sent',
  'Interview',
  'Rejected',
  'Offer',
  'Silence',
] as const;

// Statuses that mean "not applying" — derive a dash sent marker only when
// sent is genuinely empty (never overwrite an existing dash/date/free text).
export const NOT_APPLYING_STATUSES = ['Skipped', 'Filter miss'] as const;

// Bot's own outcome vocabulary (hunter/tracker.py::OUTCOME_LABELS). Only
// these four appStatus values have a matching outcome — 'Sent' applies but
// records no outcome yet.
export const OUTCOME_BY_STATUS: Partial<Record<AppStatus, string>> = {
  Interview: 'interview',
  Rejected: 'rejected',
  Offer: 'offer',
  Silence: 'silence',
};

// sent values an "applied" status derivation is allowed to overwrite with
// today's date. A real date, 'EXPIRED', or old free text is never touched
// (bot hunter/sent_parse.py::classify() treats only these — plus a genuinely
// blank string — as "not applied").
export const DASH_MARKERS = ['', '-', '—', '–'] as const;

// Marker a "not applying" status writes into a genuinely blank sent cell.
// U+2014 EM DASH — the same marker the bot stamps on SKIP/FAIL rows
// (hunter/db.py) and that hunter/sent_parse.py::classify() treats as
// "blank, not applied" (so it never counts toward the sent/funnel numbers).
export const NOT_APPLYING_SENT_MARKER = '—';

// "Today" for a derived sent date must agree with the calendar day the bot
// (and the owner) actually think it is. Neither this API's container nor the
// bot's container sets TZ explicitly (both node:22-alpine and python:3.11-
// slim default to UTC with no TZ env set — verified in both Dockerfiles/
// compose files, 2026-09-14), so relying on the API process's own local
// clock would silently drift from the bot's own notion of "today" the
// moment either container's environment changes. The bot already names an
// explicit zone for its own day-boundary logic (hunter/config.py::TIMEZONE
// = "Europe/Warsaw", the owner's real timezone) — hardcode the same zone
// here rather than lean on either container's (currently coincidental) UTC
// default.
export const BOT_TIMEZONE = 'Europe/Warsaw';

/** Today's date as YYYY-MM-DD in the given IANA timezone. */
export function todayIsoDate(timeZone: string = BOT_TIMEZONE): string {
  // en-CA formats as YYYY-MM-DD, exactly the ISO shape
  // hunter/sent_parse.py::classify() requires to treat a sent value as an
  // applied date.
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
}

/** UTC timestamp matching the bot's own outcome_at stamps. hunter/tracker.py
 * ::set_outcome (and mark_orphans_expired) write
 * `datetime.now(timezone.utc).isoformat(timespec="seconds")`, which for an
 * aware UTC datetime is `YYYY-MM-DDTHH:MM:SS+00:00` — NOT a trailing `Z`
 * (verified via `git show origin/master:hunter/tracker.py` in the bot repo,
 * 2026-09-14). A prior version of this function produced `...Z`, which never
 * matched what the bot itself writes to the same column. */
export function nowIsoSeconds(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

// The two "not applying" statuses that may carry an owner_reason. Reused by
// OWNER_REASONS below and by TrackerService's PATCH validation.
type DeclineStatus = 'Skipped' | 'Filter miss';
const DECLINE_STATUSES: readonly DeclineStatus[] = ['Skipped', 'Filter miss'];
const SKIPPED_ONLY: readonly DeclineStatus[] = ['Skipped'];

// Reason codes for why an application was Skipped (owner chose not to apply,
// filters were right to let it through) or Filter miss (the bot should have
// dropped it) — source of truth for docs plan "Applications table v2: status
// menu, decline reasons, filter-miss feedback" (approved 2026-09-14). Mirror
// this list (with labels) in job-hunter-site's models.ts, keeping `code` and
// `allowedFor` identical. `owner_reason`/`owner_reason_note` are API-owned,
// never mirrored to the Sheet, and distinct from the bot's own gate-only
// `skip_reason` column.
export const OWNER_REASON_CODES = [
  'stack',
  'fullstack_backend',
  'level',
  'title',
  'location',
  'language',
  'work_authorization',
  'contract',
  'relocation',
  'company',
  'russia',
  'duplicate',
  'expired',
  'salary',
  'not_interesting',
  'other',
] as const;
export type OwnerReasonCode = (typeof OWNER_REASON_CODES)[number];

export interface OwnerReasonMeta {
  code: OwnerReasonCode;
  allowedFor: readonly DeclineStatus[];
}

// Every code applies to both decline statuses except `salary`/`not_interesting`,
// which only make sense for a Skipped row (the owner's own call, not
// something a filter could ever detect) — see the plan's reason-code table.
export const OWNER_REASONS: readonly OwnerReasonMeta[] = OWNER_REASON_CODES.map(
  (code) => ({
    code,
    allowedFor:
      code === 'salary' || code === 'not_interesting'
        ? SKIPPED_ONLY
        : DECLINE_STATUSES,
  }),
);

/** True when `status` is one of the two decline statuses that may carry a reason. */
export function isDeclineStatus(status: string): status is DeclineStatus {
  return (DECLINE_STATUSES as readonly string[]).includes(status);
}

/** True when `code` is a known, non-empty reason code allowed for `status`. */
export function isOwnerReasonAllowedForStatus(
  code: string,
  status: string,
): boolean {
  const entry = OWNER_REASONS.find((r) => r.code === code);
  return !!entry && (entry.allowedFor as readonly string[]).includes(status);
}
