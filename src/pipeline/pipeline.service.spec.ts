import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Database from 'better-sqlite3';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildContractDb,
  NOW,
} from '../../test/fixtures/pipeline_snapshot/contract';
import { PipelineService } from './pipeline.service';

/** PipelineService whose next opens can be scripted with stub handles. */
class ScriptedService extends PipelineService {
  opens = 0;
  readonly queued: Database.Database[] = [];

  protected openHandle(path: string): Database.Database {
    this.opens += 1;
    return this.queued.shift() ?? super.openHandle(path);
  }
}

function sqliteError(code: string): Error {
  return Object.assign(new Error(`stub ${code}`), { code });
}

/** A handle whose every statement throws `err`. */
function throwingHandle(err: Error) {
  return {
    prepare: () => {
      throw err;
    },
    close: jest.fn(),
  };
}

describe('PipelineService', () => {
  let service: ScriptedService;

  beforeEach(() => {
    const path = join(mkdtempSync(join(tmpdir(), 'pipeline-svc-')), 't.db');
    buildContractDb(path);
    const config = {
      get: (key: string) => (key === 'tracker.dbPath' ? path : undefined),
    } as unknown as ConfigService;
    service = new ScriptedService(config, () => NOW);
  });
  afterEach(() => service.onModuleDestroy());

  it.each([
    'SQLITE_BUSY',
    'SQLITE_IOERR_SHORT_READ',
    'SQLITE_CORRUPT',
    'SQLITE_NOTADB',
    'SQLITE_CANTOPEN',
  ])(
    '%s during a snapshot is a 503 and the handle is reopened next time',
    (code) => {
      const stub = throwingHandle(sqliteError(code));
      service.queued.push(stub as unknown as Database.Database);

      let caught: unknown;
      try {
        service.getSnapshot('u1', 1);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ServiceUnavailableException);
      expect((caught as ServiceUnavailableException).message).toBe(
        'tracker.db temporarily unavailable',
      );
      expect(stub.close).toHaveBeenCalledTimes(1);

      // Next request: a fresh (real) handle, a normal snapshot.
      const snap = service.getSnapshot('u1', 1) as { user_id: string };
      expect(snap.user_id).toBe('u1');
      expect(service.opens).toBe(2);
      // …and it is kept once it works.
      service.getSnapshot('u1', 1);
      expect(service.opens).toBe(2);
    },
  );

  it('any other error propagates unchanged and keeps the handle', () => {
    for (const err of [new TypeError('boom'), sqliteError('SQLITE_ERROR')]) {
      const stub = throwingHandle(err);
      service.queued.push(stub as unknown as Database.Database);
      expect(() => service.getSnapshot('u1', 1)).toThrow(err);
      expect(stub.close).not.toHaveBeenCalled();
      service.onModuleDestroy(); // let the next iteration open its stub
    }
  });
});
