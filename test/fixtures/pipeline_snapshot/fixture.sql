-- Pipeline snapshot contract fixture (rows).
-- Source: job-hunter (bot) repo, docs/PIPELINE_SNAPSHOT_CONTRACT.md @ origin/master 5c35447.
-- Verbatim copy of the contract's `fixture.sql` block; applied on top of schema.sql.
-- Do not edit by hand: re-copy from the bot repo when the contract changes.

CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT);

-- hunt_runs: two hunts in the 1-day window + one three days old (cut by --days 1,
-- kept by --days 7). Totals in-window: found 230, filtered 190, dup 33/2/1,
-- new 4, capped 1, queued 3.
INSERT INTO hunt_runs (ts, "trigger", sources, found, filtered_out, filter_reasons,
    dup_url, dup_ct, dup_cooldown, "new", capped, queued, applied_inline, duration_ms) VALUES
  ('2026-09-22T11:10:00+00:00', 'scheduled', '["justjoin"]', 120, 100,
   '{"location": 60, "level": 40}', 15, 2, 1, 2, 0, 2, 0, 5000),
  ('2026-09-22T11:50:00+00:00', 'manual', '["pracuj", "justjoin"]', 110, 90,
   '{"location": 50, "keyword": 40}', 18, 0, 0, 2, 1, 1, 0, 5000),
  ('2026-09-19T12:00:00+00:00', 'scheduled', '["justjoin"]', 999, 999,
   '{"location": 999}', 0, 0, 0, 0, 0, 0, 0, 5000);

-- source_runs: NOW - 2h
INSERT INTO source_runs (source, ts, yield, ok, error) VALUES
  ('justjoin', '2026-09-22T10:00:00+00:00', 120, 1, ''),
  ('pracuj',   '2026-09-22T10:00:00+00:00', 0,   0, '429'),
  ('justjoin', '2026-09-22T10:00:00+00:00', 110, 1, '');

-- postings_seen: 3 passed + 7 rejected, all first seen NOW
INSERT INTO postings_seen (url_norm, url, source, first_seen, last_seen, seen_count,
    filter_verdict, filter_verdict_last) VALUES
  ('ex.com/0', 'https://ex.com/0', 'justjoin', '2026-09-22T12:00:00+00:00', '2026-09-22T12:00:00+00:00', 1, 'passed', 'passed'),
  ('ex.com/1', 'https://ex.com/1', 'justjoin', '2026-09-22T12:00:00+00:00', '2026-09-22T12:00:00+00:00', 1, 'passed', 'passed'),
  ('ex.com/2', 'https://ex.com/2', 'justjoin', '2026-09-22T12:00:00+00:00', '2026-09-22T12:00:00+00:00', 1, 'passed', 'passed'),
  ('ex.com/3', 'https://ex.com/3', 'justjoin', '2026-09-22T12:00:00+00:00', '2026-09-22T12:00:00+00:00', 1, 'location: Berlin', 'location: Berlin'),
  ('ex.com/4', 'https://ex.com/4', 'justjoin', '2026-09-22T12:00:00+00:00', '2026-09-22T12:00:00+00:00', 1, 'location: Berlin', 'location: Berlin'),
  ('ex.com/5', 'https://ex.com/5', 'justjoin', '2026-09-22T12:00:00+00:00', '2026-09-22T12:00:00+00:00', 1, 'location: Berlin', 'location: Berlin'),
  ('ex.com/6', 'https://ex.com/6', 'justjoin', '2026-09-22T12:00:00+00:00', '2026-09-22T12:00:00+00:00', 1, 'location: Berlin', 'location: Berlin'),
  ('ex.com/7', 'https://ex.com/7', 'justjoin', '2026-09-22T12:00:00+00:00', '2026-09-22T12:00:00+00:00', 1, 'location: Berlin', 'location: Berlin'),
  ('ex.com/8', 'https://ex.com/8', 'justjoin', '2026-09-22T12:00:00+00:00', '2026-09-22T12:00:00+00:00', 1, 'location: Berlin', 'location: Berlin'),
  ('ex.com/9', 'https://ex.com/9', 'justjoin', '2026-09-22T12:00:00+00:00', '2026-09-22T12:00:00+00:00', 1, 'location: Berlin', 'location: Berlin');

-- applications (user u1 unless noted). queued_at / claimed_at use the queue's
-- own '%Y-%m-%dT%H:%M:%SZ' format; date is the local calendar day.
INSERT INTO applications (id, date, user_id, company, title, ats_status, url, url_norm, sent, source, queued_at) VALUES
  ('p1', '2026-09-22', 'u1', 'Acme', 'Angular Dev', 'PENDING', 'https://ex.com/p1', 'ex.com/p1', '', 'justjoin', '2026-09-22T11:15:00Z'),
  ('p2', '2026-09-22', 'u1', 'Beta', 'Angular Dev', 'PENDING', 'https://ex.com/p2', 'ex.com/p2', '', 'justjoin', '2026-09-22T11:40:00Z');
INSERT INTO applications (id, date, user_id, company, title, ats_status, url, url_norm, sent, source, claimed_at) VALUES
  ('ip', '2026-09-22', 'u1', 'Example Corp', 'Angular Dev', 'IN_PROGRESS', 'https://ex.com/ip', 'ex.com/ip', '', 'justjoin', '2026-09-22T11:46:00Z');
INSERT INTO applications (id, date, user_id, company, title, ats_status, url, url_norm, sent, source, ats_verdict, cost_usd) VALUES
  ('a1', '2026-09-22', 'u1', 'Gamma', 'Angular Dev', '94', 'https://ex.com/a1', 'ex.com/a1', '', 'justjoin', 96, 0.31),
  ('a2', '2026-09-22', 'u1', 'Delta', 'Angular Dev', '88', 'https://ex.com/a2', 'ex.com/a2', '', 'justjoin', 90, NULL),
  ('a4', '2026-09-22', 'u1', 'Zeta',  'Angular Dev', '95', 'https://ex.com/a4', 'ex.com/a4', '2026-09-22', 'justjoin', 97, 0.5),
  -- CLI-served run: cost_usd 0.0, not NULL — counts as unpriced
  ('a5', '2026-09-22', 'u1', 'Omega', 'Angular Dev', '92', 'https://ex.com/a5', 'ex.com/a5', '', 'justjoin', 91, 0.0),
  -- owner declined by hand (web-UI "Filter miss" writes a dash): not ready
  ('a6', '2026-09-22', 'u1', 'Psi',   'Angular Dev', '89', 'https://ex.com/a6', 'ex.com/a6', '—', 'justjoin', 80, NULL),
  -- another user's ready row must never leak into u1's stacks
  ('x1', '2026-09-22', 'u2', 'Other', 'Angular Dev', '90', 'https://ex.com/x1', 'ex.com/x1', '', 'justjoin', 50, NULL);
INSERT INTO applications (id, date, user_id, company, title, ats_status, url, url_norm, sent, source, skip_reason) VALUES
  ('s1', '2026-09-22', 'u1', 'Theta', 'Angular Dev', 'SKIP', 'https://ex.com/s1', 'ex.com/s1', '—', 'justjoin', 'doomed:pl_onsite');
INSERT INTO applications (id, date, user_id, company, title, ats_status, url, url_norm, sent, source) VALUES
  ('e1', '2026-09-22', 'u1', 'Kappa', 'Angular Dev', 'EXPIRED', 'https://ex.com/e1', 'ex.com/e1', 'EXPIRED', 'justjoin');
INSERT INTO applications (id, date, user_id, company, title, ats_status, url, url_norm, sent, source, fail_count) VALUES
  ('f1', '2026-09-22', 'u1', 'Lambda', 'Angular Dev', 'FAIL', 'https://ex.com/f1', 'ex.com/f1', '—', 'justjoin', 1),
  ('f2', '2026-09-22', 'u1', 'Mu',     'Angular Dev', 'FAIL', 'https://ex.com/f2', 'ex.com/f2', '—', 'justjoin', 3);

-- generation_runs + pipeline_events. Finished runs are pre-M1-shaped (end-of-stage
-- events only); the in-progress run is M1-shaped (refine start + two rounds).
INSERT INTO generation_runs (run_id, user_id, url_norm, started_at, finished_at, pipeline, outcome, verdict_first, verdict_final, refine_rounds) VALUES
  ('r_ip',   'u1', 'ex.com/ip',   '2026-09-22T11:46:00+00:00', NULL,                        'cli',      NULL,                85, 88, 1),
  ('r_a1',   'u1', 'ex.com/a1',   '2026-09-22T08:40:00+00:00', '2026-09-22T09:10:00+00:00', 'cli',      'ok',                85, 88, 1),
  ('r_a2',   'u1', 'ex.com/a2',   '2026-09-22T08:40:00+00:00', '2026-09-22T09:10:00+00:00', 'cli',      'ok',                85, 88, 1),
  ('r_a4',   'u1', 'ex.com/a4',   '2026-09-22T08:40:00+00:00', '2026-09-22T09:10:00+00:00', 'cli',      'ok',                85, 88, 1),
  ('r_s1',   'u1', 'ex.com/s1',   '2026-09-22T10:20:00+00:00', '2026-09-22T10:20:20+00:00', 'cli',      'skip_doomed_gate',  85, 88, 1),
  ('r_e1',   'u1', 'ex.com/e1',   '2026-09-22T10:20:00+00:00', '2026-09-22T10:20:20+00:00', 'cli',      'expired',           85, 88, 1),
  ('r_f1',   'u1', 'ex.com/f1',   '2026-09-22T10:20:00+00:00', '2026-09-22T10:20:20+00:00', 'cli',      'cli_error',         85, 88, 1),
  -- a backfilled row must NOT count as run coverage
  ('bf_f2',  'u1', 'ex.com/f2',   '2026-09-22T10:20:00+00:00', '2026-09-22T10:20:00+00:00', 'backfill', 'ok',                85, 88, 1),
  -- a leaked open run, older than the CLI timeout (3 h)
  ('r_leak', 'u1', 'ex.com/leak', '2026-09-22T07:00:00+00:00', NULL,                        'cli',      NULL,                85, 88, 1),
  -- parent-stamped orphan: closed (not a leak), under a minute (out of rule 2)
  ('r_orph', 'u1', 'ex.com/orph', '2026-09-22T10:20:00+00:00', '2026-09-22T10:20:30+00:00', 'cli',      'orphan:cli_timeout', 85, 88, 1);

INSERT INTO pipeline_events (run_id, ts, stage, event, duration_ms, payload) VALUES
  ('r_ip', '2026-09-22T11:46:00+00:00', 'fetch',    'ok',       1000, ''),
  ('r_ip', '2026-09-22T11:51:00+00:00', 'generate', 'ok',       1000, ''),
  ('r_ip', '2026-09-22T11:53:00+00:00', 'judge',    'ok',       1000, ''),
  ('r_ip', '2026-09-22T11:56:00+00:00', 'verdict',  'ok',       1000, ''),
  ('r_ip', '2026-09-22T11:57:00+00:00', 'refine',   'start',    1000, '{"target": 95, "max_rounds": 5, "verdict_first": 85}'),
  ('r_ip', '2026-09-22T11:58:00+00:00', 'refine',   'rejected', 1000, '{"round": 1, "kind": "honest", "score": 84, "best": 85}'),
  ('r_ip', '2026-09-22T11:59:00+00:00', 'refine',   'accepted', 1000, '{"round": 2, "kind": "honest", "score": 90, "best": 90}'),
  ('r_a1', '2026-09-22T08:40:00+00:00', 'fetch',    'ok', 1000, ''),
  ('r_a1', '2026-09-22T08:45:00+00:00', 'generate', 'ok', 1000, ''),
  ('r_a1', '2026-09-22T08:47:00+00:00', 'judge',    'ok', 1000, ''),
  ('r_a1', '2026-09-22T08:50:00+00:00', 'verdict',  'ok', 1000, ''),
  ('r_a2', '2026-09-22T08:40:00+00:00', 'fetch',    'ok', 1000, ''),
  ('r_a2', '2026-09-22T08:45:00+00:00', 'generate', 'ok', 1000, ''),
  ('r_a2', '2026-09-22T08:47:00+00:00', 'judge',    'ok', 1000, ''),
  ('r_a2', '2026-09-22T08:50:00+00:00', 'verdict',  'ok', 1000, ''),
  ('r_a4', '2026-09-22T08:40:00+00:00', 'fetch',    'ok', 1000, ''),
  ('r_a4', '2026-09-22T08:45:00+00:00', 'generate', 'ok', 1000, ''),
  ('r_a4', '2026-09-22T08:47:00+00:00', 'judge',    'ok', 1000, ''),
  ('r_a4', '2026-09-22T08:50:00+00:00', 'verdict',  'ok', 1000, ''),
  ('r_s1',   '2026-09-22T10:20:00+00:00', 'fetch', 'ok', 1000, ''),
  ('r_e1',   '2026-09-22T10:20:00+00:00', 'fetch', 'ok', 1000, ''),
  ('r_f1',   '2026-09-22T10:20:00+00:00', 'fetch', 'ok', 1000, ''),
  ('r_leak', '2026-09-22T07:00:00+00:00', 'fetch', 'ok', 1000, ''),
  ('r_orph', '2026-09-22T10:20:00+00:00', 'fetch', 'ok', 1000, '');

-- LLM outage pause armed until NOW + 30 min (epoch seconds of 2026-09-22T12:30:00Z)
INSERT INTO config (key, value) VALUES ('llm_outage_until', '1790080200');
