import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Database from 'better-sqlite3';
import { FunnelData, TrackerService } from '../tracker/tracker.service';
import { inferSource } from './infer-source';

export interface SourceStats {
  source: string;
  tracked: number;
  generated: number;
  sent: number;
  confirmed: number;
  answered: number;
}

export interface CostSummary {
  totalCostUsd: number;
  averageCostUsd: number;
  applicationsWithCost: number;
}

export interface TimelinePoint {
  date: string;
  count: number;
}

const NON_SENT = new Set(['', '—', '–', '-', 'expired']);

function isGenerated(atsStatus: string | null): boolean {
  const value = atsStatus ?? '';
  return /\d/.test(value) && value.includes('%');
}

function isSent(sent: string | null): boolean {
  return !NON_SENT.has((sent ?? '').trim().toLowerCase());
}

@Injectable()
export class AnalyticsService {
  private readonly db: Database.Database;

  constructor(
    private readonly config: ConfigService,
    private readonly tracker: TrackerService,
  ) {
    this.db = new Database(this.config.get<string>('tracker.dbPath')!);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
  }

  getFunnel(userId: string, days?: number): FunnelData {
    return this.tracker.getFunnel(userId, days);
  }

  getPerSource(userId: string, days?: number): SourceStats[] {
    const rows = this.dateFilteredRows(userId, days, 'url, ats_status, sent, confirmation, answer') as {
      url: string;
      ats_status: string;
      sent: string;
      confirmation: string;
      answer: string;
    }[];

    const bySource = new Map<string, SourceStats>();
    for (const row of rows) {
      const source = inferSource(row.url);
      const stats = bySource.get(source) ?? {
        source,
        tracked: 0,
        generated: 0,
        sent: 0,
        confirmed: 0,
        answered: 0,
      };
      stats.tracked += 1;
      stats.generated += isGenerated(row.ats_status) ? 1 : 0;
      stats.sent += isSent(row.sent) ? 1 : 0;
      stats.confirmed += row.confirmation?.trim() ? 1 : 0;
      stats.answered += row.answer?.trim() ? 1 : 0;
      bySource.set(source, stats);
    }

    return [...bySource.values()].sort(
      (a, b) =>
        b.sent - a.sent ||
        b.generated - a.generated ||
        a.source.localeCompare(b.source),
    );
  }

  getCostSummary(userId: string, days?: number): CostSummary {
    const rows = this.dateFilteredRows(userId, days, 'cost_usd') as {
      cost_usd: number | null;
    }[];
    const withCost = rows.filter((row) => row.cost_usd !== null);
    const total = withCost.reduce((sum, row) => sum + (row.cost_usd ?? 0), 0);

    return {
      totalCostUsd: round4(total),
      averageCostUsd: withCost.length ? round4(total / withCost.length) : 0,
      applicationsWithCost: withCost.length,
    };
  }

  getTimeline(userId: string, days: number): TimelinePoint[] {
    const args: unknown[] = [userId];
    let where = `WHERE user_id = ? AND date != ''`;
    if (days && days > 0) {
      where += ` AND date >= date('now', ?)`;
      args.push(`-${days} days`);
    }
    return this.db
      .prepare(
        `SELECT date, COUNT(*) as count FROM applications ${where} GROUP BY date ORDER BY date ASC`,
      )
      .all(...args) as TimelinePoint[];
  }

  private dateFilteredRows(
    userId: string,
    days: number | undefined,
    columns: string,
  ): Record<string, unknown>[] {
    const args: unknown[] = [userId];
    let where = 'WHERE user_id = ?';
    if (days && days > 0) {
      where += ` AND date >= date('now', ?)`;
      args.push(`-${days} days`);
    }
    return this.db
      .prepare(`SELECT ${columns} FROM applications ${where}`)
      .all(...args) as Record<string, unknown>[];
  }
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}
