# Pipeline snapshot contract fixtures

Source: the job-hunter (bot) repo, `docs/PIPELINE_SNAPSHOT_CONTRACT.md` at
`origin/master` 5c35447 (docs/PIPELINE_VIZ_PLAN.md M2 — incl. #296
`run.refine_target` / `run.refine_max_rounds` and #297 `events[].details`,
user-scoped events + open-run lookup, raw `ts` on `run.last_event` /
`run.refine_progress`). The bot owns the contract; these files are copies, not originals.

- `schema.sql` — the empty tracker.db the contract's fixture is applied to
  (bot `hunter.db.init_db()` + the four lazy DDLs + `config`), generated from
  the bot's own DDL. The contract lists a bot-side `schema.sql` as a follow-up;
  when that lands, replace this with a byte-copy.
- `fixture.sql` — the contract's `fixture.sql` block, verbatim below its
  header comment. Every timestamp is fixed relative to
  `NOW = 2026-09-22T12:00:00+00:00`.
- `expected.json` — the contract's `expected.json` block, verbatim (JSON has
  no comments, hence this file). It is the bot tool's own output
  (`--days 1 --user u1 --events 10`, no failures log); the API returns the
  same object minus the contract's "Not in the contract" keys — see
  `src/pipeline/pipeline-snapshot.spec.ts::toApiShape`.

Re-copy all three when the contract changes; never edit them by hand.

**Exception, pending the bot contract update:** the `/pipeline` control plan
("live loaders, next-run time, action buttons") fixes the shape of
`hunt.live`, `hunt.next` and `control`, the `bot_commands` / `hunt_live` DDL
and the `bot_state.*` config keys up front, while the bot PR that adds them
to `docs/PIPELINE_SNAPSHOT_CONTRACT.md` is built in parallel. Until it lands,
the marked blocks at the END of `schema.sql` and `fixture.sql`, and the
`hunt.live` / `hunt.next` / `control` keys of `expected.json`, are written
here from that shared contract. Replace them with byte-copies once the bot's
contract carries them.
