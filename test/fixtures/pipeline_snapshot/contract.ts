/**
 * Loaders for the pipeline snapshot contract fixtures (see README.md here),
 * shared by src/pipeline/pipeline-snapshot.spec.ts and
 * test/pipeline.e2e-spec.ts.
 */
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join } from 'path';

export const SCHEMA_SQL = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
export const FIXTURE_SQL = readFileSync(join(__dirname, 'fixture.sql'), 'utf8');
export const EXPECTED = JSON.parse(
  readFileSync(join(__dirname, 'expected.json'), 'utf8'),
) as Record<string, any>;

/** The contract's frozen instant (Warsaw 14:00 CEST on 2026-09-22). */
export const NOW = new Date('2026-09-22T12:00:00+00:00');
/** Create the contract tracker.db (schema + rows) at `path`. */
export function buildContractDb(path: string): void {
  const db = new Database(path);
  db.exec(SCHEMA_SQL);
  db.exec(FIXTURE_SQL);
  db.close();
}

/**
 * The contract's expected.json minus its "Not in the contract" section:
 * `next_slot`, `hunt.window`, local-config keys, `coverage`, every `at`
 * display string and `events[].payload` (the 80-char display string —
 * `events[].details` IS in the contract and stays). The raw `ts` on
 * `run.last_event` / `run.refine_progress` is in the contract since 5c35447.
 */
export function toApiShape(expected: Record<string, any>): Record<string, any> {
  const e = structuredClone(expected);
  delete e.coverage;
  delete e.hunt.next_slot;
  delete e.hunt.window;
  if (e.hunt.hunt_runs?.last) delete e.hunt.hunt_runs.last.at;
  delete e.apply.queue_enabled_local_config;
  delete e.apply.failures.next_retry;
  for (const card of e.apply.in_progress.cards) {
    for (const key of ['last_event', 'refine_progress']) {
      if (card.run?.[key]) {
        delete card.run[key].at;
      }
    }
  }
  for (const ev of e.events ?? []) {
    delete ev.at;
    delete ev.payload;
  }
  return e;
}
