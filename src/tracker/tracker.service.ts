import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Database from 'better-sqlite3';
import { Application } from './dto/application.dto';
import {
  ApplicationStatus,
  QueryApplicationsDto,
  SortableColumn,
} from './dto/query.dto';

export interface PaginatedResult<T> {
  data: T[];
  meta: { page: number; limit: number; total: number; totalPages: number };
}

export type ApplicationStats = Record<ApplicationStatus, number> & {
  total: number;
};

export interface FunnelData {
  tracked: number;
  generated: number;
  sent: number;
  confirmed: number;
  answered: number;
}

const APPLICATION_COLUMNS = `
  id, date, company, title, stack, ats_status, url, folder,
  sent, reapplication, to_learn, cost_usd, ats_verdict
`;

// Bot doesn't store a status column — derive one from ats_status/sent so
// filtering and stats can bucket applications the way the frontend needs.
const STATUS_CASE = `
  CASE
    WHEN sent = 'EXPIRED' OR ats_status = 'EXPIRED' THEN 'expired'
    WHEN ats_status = 'FAIL' OR ats_status = 'SKIP' THEN 'failed'
    WHEN ats_status = '' OR ats_status = '—' OR ats_status = 'MANUAL' THEN 'pending'
    WHEN sent != '' THEN 'sent'
    ELSE 'applied'
  END
`;

@Injectable()
export class TrackerService {
  private readonly db: Database.Database;

  constructor(private readonly config: ConfigService) {
    this.db = new Database(this.config.get<string>('tracker.dbPath')!);
    this.db.pragma('journal_mode = WAL');
  }

  getApplications(params: QueryApplicationsDto): PaginatedResult<Application> {
    const page = params.page ?? 1;
    const limit = params.limit ?? 50;
    const sort: SortableColumn = params.sort ?? 'date';
    const order = params.order === 'asc' ? 'ASC' : 'DESC';

    const where: string[] = [];
    const args: unknown[] = [];

    if (params.status) {
      where.push(`(${STATUS_CASE}) = ?`);
      args.push(params.status);
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
        `SELECT ${APPLICATION_COLUMNS} FROM applications ${whereSql} ORDER BY ${sort} ${order} LIMIT ? OFFSET ?`,
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
    const rows = this.db
      .prepare(
        `SELECT (${STATUS_CASE}) as status, COUNT(*) as c FROM applications GROUP BY status`,
      )
      .all() as { status: ApplicationStatus; c: number }[];

    const stats: ApplicationStats = {
      total: 0,
      applied: 0,
      sent: 0,
      failed: 0,
      expired: 0,
      pending: 0,
    };
    for (const row of rows) {
      stats[row.status] = row.c;
      stats.total += row.c;
    }
    return stats;
  }

  getFunnel(days?: number): FunnelData {
    const args: unknown[] = [];
    let where = '';
    if (days && days > 0) {
      where = `WHERE date >= date('now', ?)`;
      args.push(`-${days} days`);
    }

    const row = this.db
      .prepare(
        `SELECT
          COUNT(*) as tracked,
          SUM(CASE WHEN folder != '' THEN 1 ELSE 0 END) as generated,
          SUM(CASE WHEN sent != '' AND sent != 'EXPIRED' THEN 1 ELSE 0 END) as sent,
          SUM(CASE WHEN confirmation != '' THEN 1 ELSE 0 END) as confirmed,
          SUM(CASE WHEN answer != '' THEN 1 ELSE 0 END) as answered
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

  updateReapplication(id: string, value: string): void {
    this.updateField(id, 'reapplication', value);
  }

  private updateField(
    id: string,
    column: 'sent' | 'to_learn' | 'reapplication',
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
