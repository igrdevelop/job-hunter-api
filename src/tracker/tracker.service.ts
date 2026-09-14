import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Database from 'better-sqlite3';
import { runTrackerMigrations } from '../db/tracker-migrations';
import {
  APPLIED_STATUSES,
  AppStatus,
  BOT_DASH_ATS_STATUSES,
  DASH_MARKERS,
  isOwnerReasonAllowedForStatus,
  NOT_APPLYING_SENT_MARKER,
  NOT_APPLYING_STATUSES,
  nowIsoSeconds,
  OUTCOME_BY_STATUS,
  todayIsoDate,
} from './app-status';
import { Application } from './dto/application.dto';
import { UpdateApplicationDto } from './dto/update.dto';
import {
  QueryApplicationsDto,
  SortableColumn,
  SORT_COLUMN_MAP,
} from './dto/query.dto';

export interface PaginatedResult<T> {
  data: T[];
  meta: { page: number; limit: number; total: number; totalPages: number };
}

export interface ApplicationStats {
  total: number;
  unsent: number;
  filled: number;
}

export interface FunnelData {
  tracked: number;
  generated: number;
  sent: number;
  confirmed: number;
  answered: number;
}

// A dash ('-', '—', '–') means the row was already reviewed and marked as
// not applicable — it counts as processed/filled, not unsent. Only a truly
// empty value means the row still needs review.
const UNSENT_SQL = `TRIM(sent) = ''`;
const FILLED_SQL = `TRIM(sent) != ''`;

const APPLICATION_COLUMNS = `
  id, date, company, title, stack,
  ats_status as atsStatus, url, folder, sent,
  to_learn as toLearn, cost_usd as costUsd, ats_verdict as atsVerdict,
  reapplication, drive_url as driveUrl, app_status as appStatus,
  owner_reason as ownerReason, owner_reason_note as ownerReasonNote
`;

// Source of truth: COLUMNS in the bot's hunter/gsheets_client.py (A–K).
// Only these writable columns exist in the Sheets mirror. Forgetting to add
// the next one here is silent — the PATCH writes the DB but resync_dirty()
// never sees the row, so the sheet stays stale.
const SHEETS_MIRRORED_COLUMNS = ['sent', 'to_learn', 'reapplication'] as const;
type SheetsMirroredColumn = (typeof SHEETS_MIRRORED_COLUMNS)[number];
// app_status/owner_reason/owner_reason_note are API-owned (never mirrored);
// outcome_label/outcome_at are bot-owned but written here (see
// updateApplication) through the same dirty-if-still-on-the-sheet rule as a
// mirrored column.
type UpdatableColumn =
  SheetsMirroredColumn | 'app_status' | 'owner_reason' | 'owner_reason_note';

@Injectable()
export class TrackerService {
  readonly db: Database.Database;

  constructor(private readonly config: ConfigService) {
    this.db = new Database(this.config.get<string>('tracker.dbPath'));
    // Shared with the bot process — WAL for reader/writer concurrency;
    // busy_timeout so a short bot write doesn't fail our PATCH with SQLITE_BUSY.
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');

    // Get owner id from app.sqlite for the backfill.
    const appDbPath = this.config.get<string>('app.dbPath')!;
    let ownerUserId = '';
    try {
      const appDb = new Database(appDbPath, { readonly: true });
      const row = appDb
        .prepare(`SELECT id FROM users WHERE role = 'admin' LIMIT 1`)
        .get() as { id: string } | undefined;
      appDb.close();
      ownerUserId = row?.id ?? '';
    } catch {
      // app.sqlite may not exist yet on first boot; migration runs with empty owner id.
    }

    runTrackerMigrations(this.db, ownerUserId);
  }

  getApplications(
    userId: string,
    params: QueryApplicationsDto,
  ): PaginatedResult<Application> {
    const page = params.page ?? 1;
    const limit = params.limit ?? 50;
    const sort: SortableColumn = params.sort ?? 'date';
    const sortColumn = SORT_COLUMN_MAP[sort];
    const order = params.order === 'asc' ? 'ASC' : 'DESC';

    const where: string[] = ['user_id = ?'];
    const args: unknown[] = [userId];

    if (params.status === 'unsent') {
      where.push(UNSENT_SQL);
    } else if (params.status === 'filled') {
      where.push(FILLED_SQL);
    }
    if (params.search) {
      where.push('(company LIKE ? OR title LIKE ?)');
      const term = `%${params.search}%`;
      args.push(term, term);
    }
    const whereSql = `WHERE ${where.join(' AND ')}`;

    const total = (
      this.db
        .prepare(`SELECT COUNT(*) c FROM applications ${whereSql}`)
        .get(...args) as { c: number }
    ).c;

    const data = this.db
      .prepare(
        `SELECT ${APPLICATION_COLUMNS} FROM applications ${whereSql} ORDER BY ${sortColumn} ${order} LIMIT ? OFFSET ?`,
      )
      .all(...args, limit, (page - 1) * limit) as Application[];

    return {
      data,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    };
  }

  getApplicationById(userId: string, id: string): Application | null {
    const row = this.db
      .prepare(
        `SELECT ${APPLICATION_COLUMNS} FROM applications WHERE id = ? AND user_id = ?`,
      )
      .get(id, userId) as Application | undefined;
    return row ?? null;
  }

  getStats(userId: string): ApplicationStats {
    const row = this.db
      .prepare(
        `SELECT
          COUNT(*) as total,
          SUM(CASE WHEN ${UNSENT_SQL} THEN 1 ELSE 0 END) as unsent,
          SUM(CASE WHEN ${FILLED_SQL} THEN 1 ELSE 0 END) as filled
        FROM applications WHERE user_id = ?`,
      )
      .get(userId) as ApplicationStats;

    return {
      total: row.total ?? 0,
      unsent: row.unsent ?? 0,
      filled: row.filled ?? 0,
    };
  }

  getFunnel(userId: string, days?: number): FunnelData {
    const args: unknown[] = [userId];
    let where = 'WHERE user_id = ?';
    if (days && days > 0) {
      where += ` AND date >= date('now', ?)`;
      args.push(`-${days} days`);
    }

    const row = this.db
      .prepare(
        `SELECT
          COUNT(*) as tracked,
          SUM(CASE WHEN ats_status GLOB '*[0-9]*' AND instr(ats_status, '%') > 0 THEN 1 ELSE 0 END) as generated,
          SUM(CASE WHEN LOWER(TRIM(sent)) NOT IN ('', '—', '–', '-', 'expired') THEN 1 ELSE 0 END) as sent,
          SUM(CASE WHEN TRIM(confirmation) != '' THEN 1 ELSE 0 END) as confirmed,
          SUM(CASE WHEN TRIM(answer) != '' THEN 1 ELSE 0 END) as answered
        FROM applications ${where}`,
      )
      .get(...args) as FunnelData;

    return {
      tracked: row.tracked ?? 0,
      generated: row.generated ?? 0,
      sent: row.sent ?? 0,
      confirmed: row.confirmed ?? 0,
      answered: row.answered ?? 0,
    };
  }

  /**
   * Applies every present field on the PATCH body in one transaction, then
   * derives sent/outcome_label/outcome_at from `appStatus` per the plan's
   * mapping table (docs/APPLICATIONS_STATUS_NOTE_PLAN.md "Design" section):
   *  - An "applied" status (Sent/Interview/Rejected/Offer/Silence) fills
   *    `sent` with today's date ONLY when it is still blank or a dash
   *    marker — a real date, EXPIRED, or old free text is never overwritten.
   *    The four with a matching bot outcome label also set outcome_label +
   *    outcome_at, but only when the label actually differs from what's
   *    already stored (never re-stamp outcome_at for no reason) — and NEVER
   *    to clear one (the bot's own Sheet-pull would silently undo a clear).
   *  - A "not applying" status (Skipped/Filter miss) fills `sent` with the
   *    bot's own em-dash marker, but only when `sent` is genuinely empty.
   *  - Derivation is skipped entirely when the same PATCH body also sends an
   *    explicit `sent` — that edit always wins, and lets a client restore
   *    both fields exactly (e.g. an undo/revert flow).
   *
   * `ownerReason`/`ownerReasonNote` (the decline-reason category + optional
   * comment behind the Skipped/Filter-miss dialog, docs plan "Applications
   * table v2") follow their own, independent rules:
   *  - A non-empty `ownerReason` must be a known code (enforced by the DTO's
   *    `@IsIn`) AND allowed for the *resulting* status — this body's
   *    `appStatus` if present, else the row's current `app_status` — per
   *    OWNER_REASONS' per-status allowlist (e.g. `salary` is Skipped-only).
   *    Violating either → BadRequestException, nothing written at all.
   *  - The body may not send a non-empty `ownerReasonNote` together with an
   *    explicit `ownerReason: ''` in the same PATCH — that combination
   *    contradicts itself (clearing the reason while attaching a comment to
   *    it) → BadRequestException, nothing written. A body that only clears
   *    `ownerReason` without mentioning the note at all is NOT rejected; the
   *    stored note is left as-is (simpler than guessing intent).
   *  - Whenever the resulting `appStatus` is NOT Skipped/Filter miss
   *    (including the body explicitly clearing it to `''`), both
   *    owner_reason and owner_reason_note are reset to `''` — a corrected
   *    mistake must not leave a stale reason in the analysis data. This
   *    firing is unconditional (it does not matter whether the body also
   *    touched the reason fields), and can only happen after the validation
   *    above already passed, since a non-empty reason on a non-decline
   *    resulting status is rejected before any write occurs.
   *  - Otherwise (resulting status stays Skipped/Filter miss) — if the body
   *    does NOT send `ownerReason` at all, the STORED reason is re-checked
   *    against the resulting status and cleared (note left alone) if it's no
   *    longer allowed there. This closes a gap where e.g. PATCH
   *    `{appStatus:'Filter miss'}` on a row whose stored owner_reason is
   *    `salary` (Skipped-only) used to leave that now-invalid combination in
   *    place, because 'Filter miss' is still a decline status so the
   *    unconditional reset above never fired.
   *  - owner_reason/owner_reason_note are API-owned, like app_status: never
   *    part of SHEETS_MIRRORED_COLUMNS, so they never dirty the Sheet row.
   *
   * `appStatus: ''` (Clear) on a row that WAS Skipped/Filter miss and whose
   * `sent` is still a dash marker also undoes that marker (see
   * `deriveFromAppStatus`'s `''` branch) — a mis-clicked decline can be
   * fully undone in one click, but ONLY when `ats_status` shows the dash
   * wasn't the bot's own SKIP/FAIL stamp (`BOT_DASH_ATS_STATUSES` in
   * app-status.ts — `previousStatus` alone can't tell the two apart, since
   * the bot stamps '—' at INSERT time, before this API's appStatus is ever
   * touched). It never touches a genuine date/EXPIRED/free text in `sent`,
   * and it never touches `outcome_label`/`outcome_at` (clearing those stays
   * Telegram `/outcome <id> clear` — the bot's own Sheet-pull would silently
   * undo an api-side clear, same reasoning as the "never clear an outcome"
   * rule below).
   *
   * Returns null / throws NotFoundException for an unknown id or another
   * user's row, exactly like the individual field updates used to, and
   * writes nothing in that case.
   */
  updateApplication(
    userId: string,
    id: string,
    dto: UpdateApplicationDto,
  ): Application | null {
    const hasOutcomeColumns = this.hasOutcomeColumns();

    const run = this.db.transaction(() => {
      const current = this.db
        .prepare(
          `SELECT sent, app_status, owner_reason, ats_status${hasOutcomeColumns ? ', outcome_label' : ''} FROM applications WHERE id = ? AND user_id = ?`,
        )
        .get(id, userId) as
        | {
            sent: string;
            app_status: string;
            owner_reason: string;
            ats_status: string;
            outcome_label?: string;
          }
        | undefined;
      if (!current) {
        throw new NotFoundException(`Application ${id} not found`);
      }

      // Resulting status this PATCH leaves the row in: the body's own
      // appStatus if it sends one, else whatever is already stored.
      const resultingStatus = (
        dto.appStatus !== undefined ? dto.appStatus : current.app_status
      ) as AppStatus;

      if (
        dto.ownerReason &&
        !isOwnerReasonAllowedForStatus(dto.ownerReason, resultingStatus)
      ) {
        throw new BadRequestException(
          `ownerReason "${dto.ownerReason}" is not allowed for status "${resultingStatus || '(none)'}"`,
        );
      }
      if (dto.ownerReason === '' && dto.ownerReasonNote) {
        throw new BadRequestException(
          'ownerReasonNote must be empty when ownerReason is cleared to ""',
        );
      }

      if (dto.sent !== undefined) {
        this.setColumn(userId, id, 'sent', dto.sent);
      }
      if (dto.toLearn !== undefined) {
        this.setColumn(userId, id, 'to_learn', dto.toLearn);
      }
      if (dto.reapplication !== undefined) {
        this.setColumn(userId, id, 'reapplication', dto.reapplication);
      }
      if (dto.ownerReason !== undefined) {
        this.setColumn(userId, id, 'owner_reason', dto.ownerReason);
      }
      if (dto.ownerReasonNote !== undefined) {
        this.setColumn(userId, id, 'owner_reason_note', dto.ownerReasonNote);
      }
      // Keyed off the RESULTING status, not just a body appStatus: a lone
      // ownerReasonNote patched onto a non-decline row must not survive as an
      // orphan comment. Validation above already rejected a non-empty
      // ownerReason here, so resetting both fields is always safe.
      if (
        !(NOT_APPLYING_STATUSES as readonly string[]).includes(resultingStatus)
      ) {
        this.setColumn(userId, id, 'owner_reason', '');
        this.setColumn(userId, id, 'owner_reason_note', '');
      } else if (
        dto.ownerReason === undefined &&
        current.owner_reason &&
        !isOwnerReasonAllowedForStatus(current.owner_reason, resultingStatus)
      ) {
        // The body didn't touch ownerReason, but a status change (or
        // pre-existing bad data) left the STORED reason invalid for the
        // resulting status — e.g. Skipped+'salary' PATCHed to Filter miss.
        // Clear the reason only; the note is free text and may still apply.
        this.setColumn(userId, id, 'owner_reason', '');
      }

      if (dto.appStatus !== undefined) {
        this.setColumn(userId, id, 'app_status', dto.appStatus);

        if (dto.sent === undefined) {
          this.deriveFromAppStatus(
            userId,
            id,
            dto.appStatus as AppStatus,
            current.sent,
            current.app_status as AppStatus,
            hasOutcomeColumns,
            current.outcome_label ?? '',
            current.ats_status,
          );
        }
      }

      return this.getApplicationById(userId, id);
    });

    // IMMEDIATE, not the library default DEFERRED: a DEFERRED transaction
    // only takes SQLite's write lock at its first write statement, so the
    // SELECT above runs against a snapshot that can go stale if the bot's
    // process commits a write to the same row between our SELECT and our
    // first UPDATE — the subsequent lock upgrade then fails with
    // SQLITE_BUSY_SNAPSHOT (a snapshot conflict, not a plain lock wait, so
    // `busy_timeout` does not retry it) and the whole PATCH 500s. IMMEDIATE
    // takes the write lock up front, before the SELECT even runs, closing
    // that window.
    return run.immediate();
  }

  private deriveFromAppStatus(
    userId: string,
    id: string,
    status: AppStatus,
    currentSent: string,
    previousStatus: AppStatus,
    hasOutcomeColumns: boolean,
    currentOutcomeLabel: string,
    currentAtsStatus: string,
  ): void {
    const trimmedSent = currentSent.trim();

    if ((APPLIED_STATUSES as readonly string[]).includes(status)) {
      if ((DASH_MARKERS as readonly string[]).includes(trimmedSent)) {
        this.setColumn(userId, id, 'sent', todayIsoDate());
      }

      const outcomeLabel = OUTCOME_BY_STATUS[status];
      if (
        outcomeLabel &&
        hasOutcomeColumns &&
        currentOutcomeLabel !== outcomeLabel
      ) {
        this.setOutcome(userId, id, outcomeLabel);
      }
    } else if ((NOT_APPLYING_STATUSES as readonly string[]).includes(status)) {
      if (trimmedSent === '') {
        this.setColumn(userId, id, 'sent', NOT_APPLYING_SENT_MARKER);
      }
    } else if (status === '') {
      // Clear ("Undo" a mis-clicked decline): only when the row was
      // PREVIOUSLY a decline status (Skipped/Filter miss) AND `sent` still
      // holds a dash marker AND that dash was not itself stamped by the bot
      // — never a real date/EXPIRED/free text, and never a bot-written dash.
      // `previousStatus` alone isn't enough provenance: the bot stamps '—'
      // at INSERT time on its own SKIP/FAIL rows, before this API's appStatus
      // is ever touched, so a bot SKIP row the owner later marks "Skipped"
      // here would otherwise look identical to a dash this API derived
      // itself. `ats_status` is bot-owned (this API never writes it), so its
      // current value ('SKIP'/'FAIL', see BOT_DASH_ATS_STATUSES) is a
      // reliable proxy for "the bot, not this API, put that dash there" —
      // Clear leaves it alone in that case. Excludes '' itself from the dash
      // check (an already-blank sent has nothing to undo).
      if (
        (NOT_APPLYING_STATUSES as readonly string[]).includes(previousStatus) &&
        trimmedSent !== '' &&
        (DASH_MARKERS as readonly string[]).includes(trimmedSent) &&
        !(BOT_DASH_ATS_STATUSES as readonly string[]).includes(currentAtsStatus)
      ) {
        this.setColumn(userId, id, 'sent', '');
      }
    }
  }

  private setColumn(
    userId: string,
    id: string,
    column: UpdatableColumn,
    value: string,
  ): void {
    // Column name is interpolated from a closed union — not user input.
    // Dirty status is derived from the same SHEETS_MIRRORED_COLUMNS list
    // that drives resync_dirty() on the bot side — never passed in by the
    // caller, so a column can't accidentally be dirtied/not-dirtied out of
    // step with that list.
    const mirrored = (SHEETS_MIRRORED_COLUMNS as readonly string[]).includes(
      column,
    );
    // app_status/owner_reason/owner_reason_note are API-owned and not in the
    // A–K mirror; dirtying them would make resync_dirty() overwrite the
    // whole sheet row for columns that aren't there.
    // sheets_row IS NULL means the row was never pushed, or the owner
    // deleted it from the sheet (mark_orphans_expired). Dirtying that
    // would append a resurrected row via resync_dirty() → append_rows.
    const setDirty = mirrored
      ? ', sheets_dirty = CASE WHEN sheets_row IS NOT NULL THEN 1 ELSE sheets_dirty END'
      : '';
    const result = this.db
      .prepare(
        `UPDATE applications SET ${column} = ?${setDirty} WHERE id = ? AND user_id = ?`,
      )
      .run(value, id, userId);
    if (result.changes === 0) {
      throw new NotFoundException(`Application ${id} not found`);
    }
  }

  // outcome_label/outcome_at are bot-owned columns (docs/improvement-2026-09/
  // 08-DATA_EVAL_PLAN.md M1) that may not exist on an older tracker.db —
  // checked live (not cached at startup) since the bot can add them to a
  // running tracker.db independently of this API process's lifecycle.
  private hasOutcomeColumns(): boolean {
    const cols = (
      this.db.prepare('PRAGMA table_info(applications)').all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    return cols.includes('outcome_label') && cols.includes('outcome_at');
  }

  private setOutcome(userId: string, id: string, label: string): void {
    // Same "never resurrect a sheet-deleted row" dirty guard as setColumn's
    // mirrored path — the bot's own set_outcome() dirties unconditionally,
    // but this API keeps its existing orphan-row protection.
    const result = this.db
      .prepare(
        `UPDATE applications
         SET outcome_label = ?, outcome_at = ?,
             sheets_dirty = CASE WHEN sheets_row IS NOT NULL THEN 1 ELSE sheets_dirty END
         WHERE id = ? AND user_id = ?`,
      )
      .run(label, nowIsoSeconds(), id, userId);
    if (result.changes === 0) {
      throw new NotFoundException(`Application ${id} not found`);
    }
  }
}
