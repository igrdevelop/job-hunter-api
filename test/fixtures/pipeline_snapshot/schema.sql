-- Pipeline snapshot contract fixture (schema).
-- Source: job-hunter (bot) repo @ origin/master 9d338e8 — the DB the contract's
-- fixture.sql is applied to: hunter.db.init_db() + postings_seen._ensure_table,
-- source_health._ensure_table, metrics._ensure_tables, hunt_runs._ensure_table
-- + the config KV table, dumped from sqlite_master in creation order.
-- (The contract names a bot-side schema.sql as a follow-up; until it lands this
-- is generated from the bot's own DDL.) Do not edit by hand.

CREATE TABLE applications (
    id            TEXT    PRIMARY KEY,
    date          TEXT    NOT NULL DEFAULT '',
    user_id       TEXT    NOT NULL DEFAULT '',
    company       TEXT    NOT NULL DEFAULT '',
    title         TEXT    NOT NULL DEFAULT '',
    stack         TEXT    NOT NULL DEFAULT '',
    ats_status    TEXT    NOT NULL DEFAULT '',
    url           TEXT    NOT NULL DEFAULT '',
    url_norm      TEXT    NOT NULL DEFAULT '',
    folder        TEXT    NOT NULL DEFAULT '',
    sent          TEXT    NOT NULL DEFAULT '',
    reapplication TEXT    NOT NULL DEFAULT '',
    to_learn      TEXT    NOT NULL DEFAULT '',
    drive_url     TEXT    NOT NULL DEFAULT '',
    confirmation  TEXT    NOT NULL DEFAULT '',
    answer        TEXT    NOT NULL DEFAULT '',
    sheets_row    INTEGER,
    sheets_dirty  INTEGER NOT NULL DEFAULT 0,
    fail_count    INTEGER NOT NULL DEFAULT 0,
    cost_usd      REAL
, ats_verdict REAL, claimed_at TEXT, claimed_by TEXT NOT NULL DEFAULT '', outcome_label TEXT NOT NULL DEFAULT '', outcome_at TEXT, skip_reason TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '', pending_meta TEXT, queued_at TEXT);
CREATE INDEX idx_ats
    ON applications(ats_status);
CREATE INDEX idx_company
    ON applications(company);
CREATE INDEX idx_user_ats ON applications(user_id, ats_status);
CREATE TABLE subsystem_health (
    subsystem             TEXT    PRIMARY KEY,
    consecutive_failures  INTEGER NOT NULL DEFAULT 0,
    last_error            TEXT    NOT NULL DEFAULT '',
    last_alert_at          TEXT
);
CREATE TABLE user_settings (
    user_id    TEXT NOT NULL,
    key        TEXT NOT NULL,
    value      TEXT NOT NULL DEFAULT '',
    updated_at TEXT,
    PRIMARY KEY (user_id, key)
);
CREATE TABLE telegram_links (
    chat_id    INTEGER PRIMARY KEY,
    user_id    TEXT    UNIQUE NOT NULL,
    linked_at  TEXT
);
CREATE TABLE telegram_link_codes (
    code       TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    expires_at TEXT NOT NULL
);
CREATE TABLE profile_jobs (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    kind       TEXT NOT NULL,
    payload    TEXT NOT NULL DEFAULT '',
    status     TEXT NOT NULL DEFAULT 'pending',
    result     TEXT NOT NULL DEFAULT '',
    error      TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT
);
CREATE INDEX idx_profile_jobs_status
    ON profile_jobs(status, created_at);
CREATE TABLE link_attempts (
    chat_id      INTEGER PRIMARY KEY,
    window_start TEXT    NOT NULL,
    attempts     INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX idx_user_url_norm ON applications(user_id, url_norm) WHERE url_norm != '';
CREATE TABLE postings_seen (
    url_norm            TEXT    PRIMARY KEY,
    url                 TEXT    NOT NULL,
    source              TEXT    NOT NULL,
    first_seen          TEXT    NOT NULL,
    last_seen           TEXT    NOT NULL,
    seen_count          INTEGER NOT NULL DEFAULT 1,
    title               TEXT    NOT NULL DEFAULT '',
    company             TEXT    NOT NULL DEFAULT '',
    company_norm        TEXT    NOT NULL DEFAULT '',
    location_raw        TEXT    NOT NULL DEFAULT '',
    remote_mode         TEXT    NOT NULL DEFAULT '',
    city                TEXT    NOT NULL DEFAULT '',
    salary_raw          TEXT    NOT NULL DEFAULT '',
    salary_min          REAL,
    salary_max          REAL,
    salary_currency     TEXT    NOT NULL DEFAULT '',
    salary_period       TEXT    NOT NULL DEFAULT '',
    salary_contract     TEXT    NOT NULL DEFAULT '',
    salary_monthly_min  REAL,
    salary_monthly_max  REAL,
    lang                TEXT    NOT NULL DEFAULT '',
    skills_listing      TEXT    NOT NULL DEFAULT '',
    filter_verdict      TEXT    NOT NULL DEFAULT '',
    filter_verdict_last TEXT    NOT NULL DEFAULT '',
    text_hash           TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX idx_postings_seen_last ON postings_seen(last_seen);
CREATE INDEX idx_postings_seen_company ON postings_seen(company_norm);
CREATE TABLE source_runs (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    source  TEXT    NOT NULL,
    ts      TEXT    NOT NULL,
    yield   INTEGER NOT NULL DEFAULT 0,
    ok      INTEGER NOT NULL DEFAULT 1,
    error   TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX idx_source_runs_source ON source_runs(source, id);
CREATE TABLE generation_runs (
    run_id            TEXT    PRIMARY KEY,
    user_id           TEXT    NOT NULL DEFAULT '',
    url_norm          TEXT    NOT NULL DEFAULT '',
    row_id            TEXT,
    started_at        TEXT,
    finished_at       TEXT,
    pipeline          TEXT    NOT NULL DEFAULT '',
    profile           TEXT    NOT NULL DEFAULT '',
    gen_model         TEXT    NOT NULL DEFAULT '',
    judge_model       TEXT    NOT NULL DEFAULT '',
    track             TEXT    NOT NULL DEFAULT '',
    posting_lang      TEXT    NOT NULL DEFAULT '',
    source            TEXT    NOT NULL DEFAULT '',
    is_manual         INTEGER NOT NULL DEFAULT 0,
    is_force          INTEGER NOT NULL DEFAULT 0,
    ats_pre_score     REAL,
    ats_pre_keyword   REAL,
    ats_pdf_score     REAL,
    verdict_first     REAL,
    verdict_final     REAL,
    refine_rounds     INTEGER,
    refine_accepted   INTEGER,
    best_round_kind   TEXT,
    judge_violations  INTEGER,
    judge_repaired    INTEGER,
    judge_surviving   INTEGER,
    lang_gate_hits    INTEGER,
    lang_gate_blocked INTEGER,
    scrub_fixes       INTEGER,
    reused_donor      TEXT,
    cost_usd          REAL,
    outcome           TEXT,
    exit_code         INTEGER
);
CREATE INDEX idx_generation_runs_url_norm ON generation_runs(url_norm);
CREATE INDEX idx_generation_runs_started_at ON generation_runs(started_at);
CREATE TABLE pipeline_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id      TEXT    NOT NULL,
    ts          TEXT    NOT NULL,
    stage       TEXT    NOT NULL,
    event       TEXT    NOT NULL,
    duration_ms INTEGER,
    payload     TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX idx_pipeline_events_run_id ON pipeline_events(run_id, id);
CREATE TABLE hunt_runs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    ts              TEXT    NOT NULL,
    "trigger"       TEXT    NOT NULL,
    sources         TEXT    NOT NULL,
    found           INTEGER NOT NULL DEFAULT 0,
    filtered_out    INTEGER NOT NULL DEFAULT 0,
    filter_reasons  TEXT    NOT NULL DEFAULT '{}',
    dup_url         INTEGER NOT NULL DEFAULT 0,
    dup_ct          INTEGER NOT NULL DEFAULT 0,
    dup_cooldown    INTEGER NOT NULL DEFAULT 0,
    "new"           INTEGER NOT NULL DEFAULT 0,
    capped          INTEGER NOT NULL DEFAULT 0,
    queued          INTEGER NOT NULL DEFAULT 0,
    applied_inline  INTEGER NOT NULL DEFAULT 0,
    duration_ms     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_hunt_runs_ts ON hunt_runs(ts);
CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT);
