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
 * SQLite failures that mean "the file/handle is unusable right now", not a
 * bug: lock contention past busy_timeout, I/O errors, a corrupt or replaced
 * file, a lost WAL -shm. Mapped to 503, and the cached handle is dropped so
 * the next request reopens it instead of staying stuck on a dead one.
 */
const TRANSIENT_SQLITE_CODE =
  /^SQLITE_(BUSY|IOERR|CORRUPT|NOTADB|CANTOPEN)(_|$)/;

function sqliteCode(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && TRANSIENT_SQLITE_CODE.test(code)
    ? code
    : null;
}

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

  /** Open the read-only tracker.db handle (a seam for tests). */
  protected openHandle(path: string): Database.Database {
    const db = new Database(path, { readonly: true, fileMustExist: true });
    // A read-only handle can still wait for the bot's writer lock.
    db.pragma('busy_timeout = 5000');
    return db;
  }

  private handle(): Database.Database {
    if (!this.db) {
      const path = this.config.get<string>('tracker.dbPath')!;
      try {
        this.db = this.openHandle(path);
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
      const code = sqliteCode(err);
      if (code) {
        this.logger.warn(
          `pipeline snapshot failed with ${code}; dropping the tracker.db handle`,
        );
        this.dropHandle();
        throw new ServiceUnavailableException(
          'tracker.db temporarily unavailable',
        );
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

  private dropHandle(): void {
    try {
      this.db?.close();
    } catch {
      // already unusable — nothing more to release
    }
    this.db = null;
  }

  onModuleDestroy(): void {
    this.dropHandle();
  }
}
