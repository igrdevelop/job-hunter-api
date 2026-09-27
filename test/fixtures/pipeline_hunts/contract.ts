/**
 * Loaders for the hunts table + drill-down contract fixtures (README.md
 * here), shared by src/pipeline/pipeline-hunts.spec.ts and
 * test/pipeline.e2e-spec.ts.
 */
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join } from 'path';

const read = (name: string) => readFileSync(join(__dirname, name), 'utf8');

export const HUNTS_SCHEMA_SQL = read('schema.sql');
export const HUNTS_FIXTURE_SQL = read('fixture.sql');
export const EXPECTED_HUNTS = JSON.parse(read('expected_hunts.json')) as Record<
  string,
  any
>;
export const EXPECTED_HUNT_DETAIL = JSON.parse(
  read('expected_hunt_detail.json'),
) as Record<string, any>;

/** The fixture's frozen instant. */
export const HUNTS_NOW = new Date('2026-09-27T10:00:00+00:00');

/** Create the hunts contract tracker.db at `path`. */
export function buildHuntsContractDb(path: string): void {
  const db = new Database(path);
  db.exec(HUNTS_SCHEMA_SQL);
  db.exec(HUNTS_FIXTURE_SQL);
  db.close();
}
