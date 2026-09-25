import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import Database from 'better-sqlite3';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildContractDb,
  NOW,
} from '../../test/fixtures/pipeline_snapshot/contract';
import { runTrackerMigrations } from '../db/tracker-migrations';
import type { TrackerService } from '../tracker/tracker.service';
import { CreateCommandDto } from './dto/create-command.dto';
import { PipelineCommandsService } from './pipeline-commands.service';

function service(db: Database.Database): PipelineCommandsService {
  return new PipelineCommandsService(
    { db } as unknown as TrackerService,
    () => NOW,
  );
}

const dto = (kind: string, sources?: string[] | null) =>
  ({ kind, sources }) as CreateCommandDto;

/** The contract DB, read-write — it has a live hunt and a running command. */
function contractRw(): Database.Database {
  const path = join(mkdtempSync(join(tmpdir(), 'pipeline-cmd-')), 't.db');
  buildContractDb(path);
  return new Database(path);
}

/** Contract DB with no live hunt and no pending/running command. */
function idleDb(): Database.Database {
  const db = contractRw();
  db.exec(`
    UPDATE hunt_live SET step = 'done', finished_at = '2026-09-22T11:59:00+00:00';
    UPDATE bot_commands SET status = 'done' WHERE status IN ('pending', 'running');
  `);
  return db;
}

const row = (db: Database.Database, id: string) =>
  db.prepare('SELECT * FROM bot_commands WHERE id = ?').get(id) as Record<
    string,
    unknown
  >;

describe('PipelineCommandsService.create', () => {
  it('inserts a pending hunt with de-duplicated sources and a UTC-second timestamp', () => {
    const db = idleDb();
    const { id } = service(db).create(
      'owner-1',
      dto('hunt', ['linkedin', 'justjoin', 'linkedin']),
    );
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row(db, id)).toEqual({
      id,
      user_id: 'owner-1',
      kind: 'hunt',
      payload: '{"sources":["linkedin","justjoin"]}',
      status: 'pending',
      result: '',
      error: '',
      created_at: '2026-09-22T12:00:00+00:00',
      started_at: null,
      finished_at: null,
    });
    db.close();
  });

  it('hunt without sources is "hunt everywhere" ({"sources": null})', () => {
    const db = idleDb();
    const { id } = service(db).create('owner-1', dto('hunt'));
    expect(JSON.parse(row(db, id).payload as string)).toEqual({
      sources: null,
    });
    db.close();
  });

  it.each(['retry_failed', 'check_expired'])(
    '%s carries an empty payload',
    (kind) => {
      const db = idleDb();
      const { id } = service(db).create('owner-1', dto(kind, null));
      expect(row(db, id).payload).toBe('{}');
      db.close();
    },
  );

  it.each(['retry_failed', 'check_expired'])(
    '%s with sources is a 400',
    (kind) => {
      const db = idleDb();
      expect(() => service(db).create('o', dto(kind, ['linkedin']))).toThrow(
        BadRequestException,
      );
      db.close();
    },
  );

  it('an unknown source is a 400 naming it', () => {
    const db = idleDb();
    expect(() =>
      service(db).create('o', dto('hunt', ['linkedin', 'nope'])),
    ).toThrow(new BadRequestException('unknown sources: nope'));
    db.close();
  });

  it('no bot_state.sources key is a 503 when sources must be checked', () => {
    const db = idleDb();
    db.exec("DELETE FROM config WHERE key = 'bot_state.sources'");
    expect(() => service(db).create('o', dto('hunt', ['linkedin']))).toThrow(
      new ServiceUnavailableException('bot state unavailable'),
    );
    // "Hunt everywhere" names no source, so it needs no bot state.
    expect(service(db).create('o', dto('hunt')).id).toBeTruthy();
    db.close();
  });

  it('a live hunt blocks hunt and retry_failed, not check_expired', () => {
    const db = contractRw();
    db.exec("UPDATE bot_commands SET status = 'done'");
    const svc = service(db);
    expect(() => svc.create('o', dto('hunt'))).toThrow(ConflictException);
    expect(() => svc.create('o', dto('retry_failed'))).toThrow(
      ConflictException,
    );
    expect(svc.create('o', dto('check_expired')).id).toBeTruthy();
    db.close();
  });

  it('a pending/running hunt or retry command blocks both lock kinds', () => {
    for (const [kind, status] of [
      ['hunt', 'pending'],
      ['hunt', 'running'],
      ['retry_failed', 'pending'],
      ['retry_failed', 'running'],
    ]) {
      const db = idleDb();
      db.prepare(
        `INSERT INTO bot_commands (id, kind, status, created_at)
         VALUES ('x', ?, ?, '2026-09-22T11:00:00+00:00')`,
      ).run(kind, status);
      const svc = service(db);
      expect(() => svc.create('o', dto('hunt'))).toThrow(ConflictException);
      expect(() => svc.create('o', dto('retry_failed'))).toThrow(
        ConflictException,
      );
      expect(svc.create('o', dto('check_expired')).id).toBeTruthy();
      db.close();
    }
  });

  it('check_expired is blocked only by another pending/running check_expired', () => {
    const db = idleDb();
    const svc = service(db);
    svc.create('o', dto('check_expired'));
    expect(() => svc.create('o', dto('check_expired'))).toThrow(
      ConflictException,
    );
    expect(svc.create('o', dto('hunt')).id).toBeTruthy();
    db.close();
  });

  it('finished, errored and rejected commands never block', () => {
    const db = idleDb();
    db.exec(`
      INSERT INTO bot_commands (id, kind, status, created_at) VALUES
        ('a', 'hunt', 'done', 'x'), ('b', 'hunt', 'error', 'x'),
        ('c', 'retry_failed', 'rejected', 'x'), ('d', 'check_expired', 'error', 'x');
    `);
    const svc = service(db);
    expect(svc.create('o', dto('hunt')).id).toBeTruthy();
    expect(svc.create('o', dto('check_expired')).id).toBeTruthy();
    db.close();
  });

  it('a missing hunt_live table (older bot) is not a live hunt', () => {
    const db = idleDb();
    db.exec('DROP TABLE hunt_live');
    expect(service(db).create('o', dto('hunt')).id).toBeTruthy();
    db.close();
  });

  it('a refused command inserts nothing', () => {
    const db = contractRw();
    const before = db.prepare('SELECT COUNT(*) AS n FROM bot_commands').get();
    expect(() => service(db).create('o', dto('hunt'))).toThrow(
      ConflictException,
    );
    expect(db.prepare('SELECT COUNT(*) AS n FROM bot_commands').get()).toEqual(
      before,
    );
    db.close();
  });

  it('SQLITE_BUSY is a 503', () => {
    const busy = Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' });
    const db = {
      transaction: () => ({
        immediate: () => {
          throw busy;
        },
      }),
    } as unknown as Database.Database;
    expect(() => service(db).create('o', dto('check_expired'))).toThrow(
      ServiceUnavailableException,
    );
  });
});

describe('PipelineCommandsService.get', () => {
  it('returns the row with its payload parsed', () => {
    const db = contractRw();
    expect(service(db).get('c_exp')).toEqual({
      id: 'c_exp',
      kind: 'check_expired',
      payload: {},
      status: 'done',
      error: '',
      result: '{"checked": 5}',
      created_at: '2026-09-22T09:00:00+00:00',
      started_at: '2026-09-22T09:00:02+00:00',
      finished_at: '2026-09-22T09:01:00+00:00',
    });
    expect(service(db).get('c_hunt').payload).toEqual({
      sources: ['linkedin'],
    });
    db.close();
  });

  it('a garbled payload is null; an unknown id is a 404', () => {
    const db = contractRw();
    db.exec("UPDATE bot_commands SET payload = '{oops' WHERE id = 'c_rej'");
    expect(service(db).get('c_rej').payload).toBeNull();
    expect(() => service(db).get('nope')).toThrow(NotFoundException);
    db.close();
  });
});

describe('bot_commands migration', () => {
  it('is created idempotently with the contract columns', () => {
    const db = new Database(':memory:');
    runTrackerMigrations(db, '');
    runTrackerMigrations(db, '');
    const cols = (
      db.prepare('PRAGMA table_info(bot_commands)').all() as {
        name: string;
        dflt_value: string | null;
        notnull: number;
      }[]
    ).map((c) => [c.name, c.notnull, c.dflt_value]);
    expect(cols).toEqual([
      ['id', 0, null],
      ['user_id', 1, "''"],
      ['kind', 1, null],
      ['payload', 1, "'{}'"],
      ['status', 1, "'pending'"],
      ['result', 1, "''"],
      ['error', 1, "''"],
      ['created_at', 1, null],
      ['started_at', 0, null],
      ['finished_at', 0, null],
    ]);
    expect(
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE name = 'idx_bot_commands_status'",
        )
        .get(),
    ).toEqual({
      sql: 'CREATE INDEX idx_bot_commands_status ON bot_commands(status, created_at)',
    });
    db.close();
  });
});
