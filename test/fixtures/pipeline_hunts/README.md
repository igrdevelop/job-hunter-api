# Hunts table + drill-down contract fixtures

Source: the job-hunter (bot) repo, `tests/fixtures/pipeline_hunts/` on branch
`feat/hunt-drilldown` (docs/HUNT_DRILLDOWN_PLAN.md M2; the contract is the
"Hunts table + one hunt's drill-down" section of the bot's
`docs/PIPELINE_SNAPSHOT_CONTRACT.md`). The bot owns them; these are byte-copies.

- `schema.sql` — the bot's real DDL (`init_db` + the lazy `hunt_live` /
  `hunt_runs` / `hunt_jobs` / metrics tables), dumped by the bot's own test,
  which fails when the DDL drifts.
- `fixture.sql` — the rows. Clock frozen at `2026-09-27T10:00:00+00:00`,
  user `u1`.
- `expected_hunts.json` / `expected_hunt_detail.json` — the bot tool's
  output (`hunts_list` / `hunt_detail`, hunt `h_done`) with every display-only
  `at` key dropped, which is exactly the API shape.

Re-copy all four when the bot's contract changes; never edit them by hand.
