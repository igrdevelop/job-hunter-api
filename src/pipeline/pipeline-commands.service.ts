import {
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { TrackerService } from '../tracker/tracker.service';
import { BotCommandKind, CreateCommandDto } from './dto/create-command.dto';
import { botSources } from './pipeline-snapshot';
import { PIPELINE_CLOCK, sqliteCode } from './pipeline.service';
import type { PipelineClock } from './pipeline.service';
import { isoUtcSeconds } from './snapshot-time';

/** `GET /api/pipeline/commands/:id` — one `bot_commands` row. */
export interface BotCommandView {
  id: string;
  kind: string;
  /** Parsed JSON; `null` when the stored text doesn't parse. */
  payload: unknown;
  status: string;
  error: string;
  /** Raw text as the bot wrote it ('' until the command finishes). */
  result: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

/**
 * Kinds that share the bot's `_hunt_lock`: while one of them is live, a new
 * one is refused (409) instead of queued — the owner's disable-not-queue
 * decision, enforced here as well as by the bot's drain.
 */
const HUNT_LOCK_KINDS: readonly BotCommandKind[] = ['hunt', 'retry_failed'];

function tableExists(db: Database.Database, table: string): boolean {
  return (
    db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
      )
      .get(table) !== undefined
  );
}

/**
 * Operational commands from the /pipeline page to the bot, over the shared
 * `bot_commands` table (API inserts `pending`, the bot's 3 s drain claims,
 * runs and stamps `done` / `error` / `rejected`). Writes go through
 * TrackerService's read-write handle — the snapshot's handle is read-only.
 */
@Injectable()
export class PipelineCommandsService {
  private readonly logger = new Logger(PipelineCommandsService.name);

  constructor(
    private readonly tracker: TrackerService,
    @Inject(PIPELINE_CLOCK) private readonly clock: PipelineClock,
  ) {}

  create(userId: string, dto: CreateCommandDto): { id: string } {
    const sources = dto.sources ?? null;
    if (dto.kind !== 'hunt' && sources !== null) {
      throw new BadRequestException('sources is only valid for kind "hunt"');
    }
    const payload =
      dto.kind === 'hunt'
        ? { sources: sources === null ? null : [...new Set(sources)] }
        : {};

    return this.withSqlite(() => {
      const db = this.tracker.db;
      // IMMEDIATE: the busy check and the insert see the same state, and a
      // concurrent POST can't slip a second hunt in between them.
      return db
        .transaction(() => {
          if (payload.sources) this.checkSources(db, payload.sources);
          this.checkNotBusy(db, dto.kind);
          const id = randomUUID();
          db.prepare(
            `INSERT INTO bot_commands (id, user_id, kind, payload, status, created_at)
             VALUES (?, ?, ?, ?, 'pending', ?)`,
          ).run(
            id,
            userId,
            dto.kind,
            JSON.stringify(payload),
            isoUtcSeconds(this.clock().getTime()),
          );
          return { id };
        })
        .immediate();
    });
  }

  get(id: string): BotCommandView {
    const row = this.withSqlite(() =>
      tableExists(this.tracker.db, 'bot_commands')
        ? (this.tracker.db
            .prepare(
              `SELECT id, kind, payload, status, error, result, created_at,
                      started_at, finished_at
               FROM bot_commands WHERE id = ?`,
            )
            .get(id) as Record<string, unknown> | undefined)
        : undefined,
    );
    if (!row) throw new NotFoundException('command not found');
    let payload: unknown = null;
    try {
      payload = JSON.parse((row.payload as string) || '{}');
    } catch {
      payload = null;
    }
    return {
      id: row.id as string,
      kind: row.kind as string,
      payload,
      status: row.status as string,
      error: (row.error as string) ?? '',
      result: (row.result as string) ?? '',
      created_at: row.created_at as string,
      started_at: (row.started_at as string | null) ?? null,
      finished_at: (row.finished_at as string | null) ?? null,
    };
  }

  /** Every name must be one the bot itself published in `bot_state.sources`. */
  private checkSources(db: Database.Database, sources: string[]): void {
    const known = botSources(db);
    if (known === null) {
      throw new ServiceUnavailableException('bot state unavailable');
    }
    const knownSet = new Set(known);
    const unknown = sources.filter((s) => !knownSet.has(s));
    if (unknown.length) {
      throw new BadRequestException(`unknown sources: ${unknown.join(', ')}`);
    }
  }

  private checkNotBusy(db: Database.Database, kind: BotCommandKind): void {
    const lockKinds = HUNT_LOCK_KINDS.includes(kind) ? HUNT_LOCK_KINDS : [kind];
    if (lockKinds === HUNT_LOCK_KINDS && tableExists(db, 'hunt_live')) {
      const live = db
        .prepare(
          'SELECT hunt_id FROM hunt_live WHERE finished_at IS NULL LIMIT 1',
        )
        .get() as { hunt_id: string } | undefined;
      if (live) {
        throw new ConflictException(
          `a hunt is already running (${live.hunt_id})`,
        );
      }
    }
    const pending = db
      .prepare(
        `SELECT id, kind FROM bot_commands
         WHERE status IN ('pending', 'running')
           AND kind IN (${lockKinds.map(() => '?').join(', ')})
         ORDER BY created_at LIMIT 1`,
      )
      .get(...lockKinds) as { id: string; kind: string } | undefined;
    if (pending) {
      throw new ConflictException(
        `a ${pending.kind} command is already pending or running (${pending.id})`,
      );
    }
  }

  /** Transient SQLite failures (lock past busy_timeout, I/O) are a 503. */
  private withSqlite<T>(fn: () => T): T {
    try {
      return fn();
    } catch (err) {
      if (err instanceof HttpException) throw err;
      const code = sqliteCode(err);
      if (code) {
        this.logger.warn(`bot_commands access failed with ${code}`);
        throw new ServiceUnavailableException(
          'tracker.db temporarily unavailable',
        );
      }
      throw err;
    }
  }
}
