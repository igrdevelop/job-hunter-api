import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Database from 'better-sqlite3';
import { buildSnapshot, TrackerSchemaError } from './pipeline-snapshot';

export const PIPELINE_CLOCK = Symbol('PIPELINE_CLOCK');
export type PipelineClock = () => Date;

/** A snapshot slower than this is logged (docs/PIPELINE_VIZ_PLAN.md M2). */
const SLOW_SNAPSHOT_MS = 200;

/**
 * docs/PIPELINE_VIZ_PLAN.md M2 — read-only pipeline snapshot over the bot's
 * tracker.db (contract: the bot repo's docs/PIPELINE_SNAPSHOT_CONTRACT.md).
 *
 * Opens its OWN read-only handle instead of reusing TrackerService's: that
 * one is read-write and runs tracker migrations at construction, and this
 * module must never write to or migrate the bot's database. Opened lazily,
 * so a tracker.db that doesn't exist yet is a 503 on this route, not a
 * crash at boot.
 */
@Injectable()
export class PipelineService implements OnModuleDestroy {
  private readonly logger = new Logger(PipelineService.name);
  private db: Database.Database | null = null;

  constructor(
    private readonly config: ConfigService,
    @Inject(PIPELINE_CLOCK) private readonly clock: PipelineClock,
  ) {}

  private handle(): Database.Database {
    if (!this.db) {
      const path = this.config.get<string>('tracker.dbPath')!;
      try {
        this.db = new Database(path, { readonly: true, fileMustExist: true });
        // A read-only handle can still wait for the bot's writer lock.
        this.db.pragma('busy_timeout = 5000');
      } catch (err) {
        this.logger.warn(`cannot open tracker.db read-only: ${String(err)}`);
        throw new ServiceUnavailableException('tracker.db is not available');
      }
    }
    return this.db;
  }

  getSnapshot(userId: string, days: number) {
    const started = performance.now();
    let snapshot: Record<string, unknown>;
    try {
      snapshot = buildSnapshot(this.handle(), {
        days,
        userId,
        now: this.clock(),
        failuresLogPath: this.config.get<string>('pipeline.failuresLogPath'),
      });
    } catch (err) {
      if (err instanceof TrackerSchemaError) {
        throw new ServiceUnavailableException(err.message);
      }
      throw err;
    }
    const elapsed = performance.now() - started;
    if (elapsed > SLOW_SNAPSHOT_MS) {
      this.logger.warn(
        `pipeline snapshot took ${elapsed.toFixed(0)} ms (days=${days})`,
      );
    }
    return snapshot;
  }

  onModuleDestroy(): void {
    this.db?.close();
    this.db = null;
  }
}
