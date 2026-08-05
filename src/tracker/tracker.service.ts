import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Database from 'better-sqlite3';
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

const UNSENT_SQL = `LOWER(TRIM(sent)) IN ('', '—', '–', '-')`;
const FILLED_SQL = `LOWER(TRIM(sent)) NOT IN ('', '—', '–', '-')`;

const APPLICATION_COLUMNS = `
  id, date, company, title, stack,
  ats_status as atsStatus, url, folder, sent,
  to_learn as toLearn, cost_usd as costUsd, ats_verdict as atsVerdict
`;

@Injectable()
export class TrackerService {
  private readonly db: Database.Database;

  constructor(private readonly config: ConfigService) {
    this.db = new Database(this.config.get<string>('tracker.dbPath')!);
    // Shared with the bot process on the same file — WAL for readers/writers
    // concurrency; busy_timeout so a short bot write doesn't fail our PATCH
    // with SQLITE_BUSY (better-sqlite3 default timeout is 0ms).
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
  }

  getApplications(params: QueryApplicationsDto): PaginatedResult<Application> {
    const page = params.page ?? 1;
    const limit = params.limit ?? 50;
    const sort: SortableColumn = params.sort ?? 'date';
    const sortColumn = SORT_COLUMN_MAP[sort];
    const order = params.order === 'asc' ? 'ASC' : 'DESC';

    const where: string[] = [];
    const args: unknown[] = [];

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
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

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

  getApplicationById(id: string): Application | null {
    const row = this.db
      .prepare(`SELECT ${APPLICATION_COLUMNS} FROM applications WHERE id = ?`)
      .get(id) as Application | undefined;
    return row ?? null;
  }

  getStats(): ApplicationStats {
    const row = this.db
      .prepare(
        `SELECT
          COUNT(*) as total,
          SUM(CASE WHEN ${UNSENT_SQL} THEN 1 ELSE 0 END) as unsent,
          SUM(CASE WHEN ${FILLED_SQL} THEN 1 ELSE 0 END) as filled
        FROM applications`,
      )
      .get() as ApplicationStats;

    return {
      total: row.total ?? 0,
      unsent: row.unsent ?? 0,
      filled: row.filled ?? 0,
    };
  }

  getFunnel(days?: number): FunnelData {
    const args: unknown[] = [];
    let where = '';
    if (days && days > 0) {
      where = `WHERE date >= date('now', ?)`;
      args.push(`-${days} days`);
    }

    // Mirrors hunter/funnel.py: generated = ats_status has a digit and a '%'
    // (a real score, not SKIP/FAIL/MANUAL/EXPIRED/blank); sent = sent column
    // isn't one of the "not actually sent" placeholder values.
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

  updateSent(id: string, sent: string): void {
    this.updateField(id, 'sent', sent);
  }

  updateToLearn(id: string, toLearn: string): void {
    this.updateField(id, 'to_learn', toLearn);
  }

  private updateField(
    id: string,
    column: 'sent' | 'to_learn',
    value: string,
  ): void {
    const result = this.db
      .prepare(`UPDATE applications SET ${column} = ? WHERE id = ?`)
      .run(value, id);
    if (result.changes === 0) {
      throw new NotFoundException(`Application ${id} not found`);
    }
  }
}
