import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Database from 'better-sqlite3';
import { runTrackerMigrations } from '../db/tracker-migrations';
import { Application } from './dto/application.dto';
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
  reapplication, drive_url as driveUrl, app_status as appStatus
`;

// Source of truth: COLUMNS in the bot's hunter/gsheets_client.py (A–K).
// Only these writable columns exist in the Sheets mirror. Forgetting to add
// the next one here is silent — the PATCH writes the DB but resync_dirty()
// never sees the row, so the sheet stays stale.
const SHEETS_MIRRORED_COLUMNS = ['sent', 'to_learn', 'reapplication'] as const;
type SheetsMirroredColumn = (typeof SHEETS_MIRRORED_COLUMNS)[number];
type UpdatableColumn = SheetsMirroredColumn | 'app_status';

@Injectable()
export class TrackerService {
  readonly db: Database.Database;

  constructor(private readonly config: ConfigService) {
    this.db = new Database(this.config.get<string>('tracker.dbPath')!);
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

  getApplications(userId: string, params: QueryApplicationsDto): PaginatedResult<Application> {
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
      meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
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

  updateSent(userId: string, id: string, sent: string): void {
    this.updateField(userId, id, 'sent', sent);
  }

  updateToLearn(userId: string, id: string, toLearn: string): void {
    this.updateField(userId, id, 'to_learn', toLearn);
  }

  updateReapplication(userId: string, id: string, reapplication: string): void {
    this.updateField(userId, id, 'reapplication', reapplication);
  }

  updateAppStatus(userId: string, id: string, appStatus: string): void {
    this.updateField(userId, id, 'app_status', appStatus);
  }

  private updateField(
    userId: string,
    id: string,
    column: UpdatableColumn,
    value: string,
  ): void {
    // Column name is interpolated from a closed union — not user input.
    // app_status is API-owned and not in the A–K mirror; dirtying it would
    // make resync_dirty() overwrite the whole sheet row for a column that
    // is not there.
    // sheets_row IS NULL means the row was never pushed, or the owner
    // deleted it from the sheet (mark_orphans_expired). Dirtying that
    // would append a resurrected row via resync_dirty() → append_rows.
    const setDirty = (SHEETS_MIRRORED_COLUMNS as readonly UpdatableColumn[]).includes(
      column,
    )
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
}
