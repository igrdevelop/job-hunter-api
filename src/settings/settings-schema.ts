export type SettingType = 'boolean' | 'string' | 'number' | 'secret' | 'enum' | 'list';

export interface SettingDefinition {
  key: string;
  category: string;
  type: SettingType;
  description: string;
  defaultValue: string;
  isSecret: boolean;
}

/** Category display order + Material icon names for the frontend. */
export const CATEGORY_META: { name: string; icon: string }[] = [
  { name: 'Telegram', icon: 'send' },
  { name: 'Auto Apply', icon: 'play_arrow' },
  { name: 'LLM', icon: 'smart_toy' },
  { name: 'Judge', icon: 'gavel' },
  { name: 'ATS Verdict', icon: 'assessment' },
  { name: 'Translation', icon: 'translate' },
  { name: 'Gates', icon: 'block' },
  { name: 'Generation', icon: 'description' },
  { name: 'Sources', icon: 'source' },
  { name: 'Schedule', icon: 'schedule' },
  { name: 'Resilience', icon: 'shield' },
  { name: 'Google Sheets', icon: 'table_chart' },
  { name: 'Google Drive', icon: 'cloud' },
  { name: 'Gmail', icon: 'mail' },
  { name: 'Health', icon: 'monitor_heart' },
  { name: 'Backup', icon: 'backup' },
  { name: 'Paths', icon: 'folder' },
];

function def(
  key: string,
  category: string,
  type: SettingType,
  description: string,
  defaultValue: string,
  isSecret = false,
): SettingDefinition {
  return { key, category, type, description, defaultValue, isSecret };
}

/**
 * Hardcoded schema transcribed from hunter/config.py defaults.
 * Secrets are masked server-side before returning to the client.
 */
export const SETTINGS_SCHEMA: SettingDefinition[] = [
  // ── Telegram ──────────────────────────────────────────────────────────────
  def('TELEGRAM_BOT_TOKEN', 'Telegram', 'secret', 'Telegram Bot API token', '', true),
  def('TELEGRAM_CHAT_ID', 'Telegram', 'string', 'Owner chat ID for notifications', '0'),
  def(
    'TELEGRAM_SEND_DOCS',
    'Telegram',
    'boolean',
    'Send .pdf/.docx via sendDocument after apply success',
    'true',
  ),

  // ── Auto Apply ────────────────────────────────────────────────────────────
  def('AUTO_APPLY', 'Auto Apply', 'boolean', 'Automatically apply to tracked jobs', 'false'),

  // ── LLM ───────────────────────────────────────────────────────────────────
  def('LLM_PROVIDER', 'LLM', 'enum', 'Main LLM provider (anthropic / openrouter / openai)', 'anthropic'),
  def('LLM_MODEL', 'LLM', 'string', 'Main generation model', 'claude-sonnet-4-6'),
  def('LLM_API_KEY', 'LLM', 'secret', 'Primary LLM API key (wins over provider-specific keys)', '', true),
  def('ANTHROPIC_API_KEY', 'LLM', 'secret', 'Anthropic API key (fallback / judge)', '', true),
  def('OPENROUTER_API_KEY', 'LLM', 'secret', 'OpenRouter API key', '', true),
  def('OPENAI_API_KEY', 'LLM', 'secret', 'OpenAI API key', '', true),
  def('APPLY_USE_CLI', 'LLM', 'boolean', 'Use Claude CLI instead of API for apply agent', 'false'),
  def('LLM_DEFAULT_PROFILE', 'LLM', 'string', 'Named LLM profile for primary applies', ''),
  def('DUAL_SHADOW_PROFILE', 'LLM', 'string', 'Named LLM profile for dual-shadow runs', ''),

  // ── Judge ─────────────────────────────────────────────────────────────────
  def('JUDGE_ENABLED', 'Judge', 'boolean', 'Run claim-judge pass after generation', 'true'),
  def('JUDGE_MODEL', 'Judge', 'string', 'Cheap model used by the claim judge', 'claude-haiku-4-5-20251001'),
  def('JUDGE_MODE', 'Judge', 'enum', 'Judge rollout mode: report / warn / block', 'warn'),
  def('JUDGE_MAX_REPAIR_ROUNDS', 'Judge', 'number', 'Max repair rounds after judge findings', '1'),
  def('JUDGE_PROVIDER', 'Judge', 'enum', 'Judge provider (usually anthropic)', 'anthropic'),
  def('JUDGE_API_KEY', 'Judge', 'secret', 'Judge API key (falls back to ANTHROPIC_API_KEY)', '', true),

  // ── ATS Verdict ───────────────────────────────────────────────────────────
  def('ATS_VERDICT_ENABLED', 'ATS Verdict', 'boolean', 'Run independent ATS verdict after docs', 'true'),
  def('ATS_VERDICT_TARGET', 'ATS Verdict', 'number', 'Minimum verdict score before refine stops', '95'),
  def(
    'ATS_VERDICT_MAX_REFINES',
    'ATS Verdict',
    'number',
    'Max rewrite+re-verdict rounds (0 = one-shot)',
    '3',
  ),

  // ── Translation / Outreach ────────────────────────────────────────────────
  def('OUTREACH_ENABLED', 'Translation', 'boolean', 'Write outreach.md after each successful apply', 'true'),
  def('TRANSLATE_PROVIDER', 'Translation', 'enum', 'Provider for PL↔EN translation calls', 'anthropic'),
  def('TRANSLATE_MODEL', 'Translation', 'string', 'Model for translation (defaults to JUDGE_MODEL)', 'claude-haiku-4-5-20251001'),
  def('TRANSLATE_API_KEY', 'Translation', 'secret', 'Translation API key (falls back to Anthropic)', '', true),

  // ── Gates ─────────────────────────────────────────────────────────────────
  def('DOOMED_GATE_ENABLED', 'Gates', 'boolean', 'Deterministic doomed-vacancy gate before LLM', 'true'),
  def('DOOMED_GATE_HARD_ACTION', 'Gates', 'enum', 'HARD finding action: skip / warn', 'skip'),
  def('REPOST_GATE_ENABLED', 'Gates', 'boolean', 'Reuse CV for near-verbatim re-posts', 'true'),
  def('REPOST_WINDOW_DAYS', 'Gates', 'number', 'Look-back window for re-post matching', '60'),

  // ── Generation ────────────────────────────────────────────────────────────
  def('GENERATE_PL_RESUME', 'Generation', 'boolean', 'Always generate Polish resume docs', 'false'),
  def('GENERATE_ABOUT_ME_PL', 'Generation', 'boolean', 'Generate Polish About Me section', 'true'),
  def(
    'GEN_SKIP_PL_FOR_EN',
    'Generation',
    'boolean',
    'Skip PL fields on first call for English short-mode posts',
    'true',
  ),
  def('CV_GDPR_CLAUSE', 'Generation', 'enum', 'GDPR/RODO clause: both / pl / none', 'both'),
  def('CANDIDATE_TRACKS', 'Generation', 'list', 'Active candidate tracks (comma-separated)', 'angular'),

  // ── Sources ───────────────────────────────────────────────────────────────
  def('JUSTJOIN_ENABLED', 'Sources', 'boolean', 'Enable JustJoin.it scraper', 'true'),
  def('JUSTJOIN_MAX_PAGES', 'Sources', 'number', 'JustJoin pages per workplace type', '3'),
  def('NOFLUFFJOBS_ENABLED', 'Sources', 'boolean', 'Enable NoFluffJobs scraper', 'true'),
  def('LINKEDIN_ENABLED', 'Sources', 'boolean', 'Enable LinkedIn scraper', 'true'),
  def(
    'LINKEDIN_STORAGE_STATE',
    'Sources',
    'string',
    'Playwright storage state path for LinkedIn (session JSON)',
    '',
  ),
  def('BULLDOGJOB_ENABLED', 'Sources', 'boolean', 'Enable Bulldogjob scraper', 'true'),
  def('PRACUJ_ENABLED', 'Sources', 'boolean', 'Enable Pracuj.pl scraper', 'true'),
  def('THEPROTOCOL_ENABLED', 'Sources', 'boolean', 'Enable theprotocol.it scraper', 'true'),
  def('SOLIDJOBS_ENABLED', 'Sources', 'boolean', 'Enable Solid.Jobs scraper', 'true'),
  def('INHIRE_ENABLED', 'Sources', 'boolean', 'Enable Inhire.io scraper (Playwright)', 'true'),
  def('JOBLEADS_ENABLED', 'Sources', 'boolean', 'Enable JobLeads scraper', 'true'),
  def('ARBEITNOW_ENABLED', 'Sources', 'boolean', 'Enable Arbeitnow scraper', 'true'),
  def('REMOTIVE_ENABLED', 'Sources', 'boolean', 'Enable Remotive scraper', 'true'),
  def('WORKINGNOMADS_ENABLED', 'Sources', 'boolean', 'Enable Working Nomads scraper', 'true'),
  def('JOBSPRESSO_ENABLED', 'Sources', 'boolean', 'Enable Jobspresso scraper', 'true'),
  def('BUILTIN_ENABLED', 'Sources', 'boolean', 'Enable Built In scraper', 'true'),
  def('JUSTREMOTE_ENABLED', 'Sources', 'boolean', 'Enable JustRemote scraper', 'true'),
  def('REMOTEOK_ENABLED', 'Sources', 'boolean', 'Enable Remote OK scraper', 'true'),
  def('HIMALAYAS_ENABLED', 'Sources', 'boolean', 'Enable Himalayas scraper', 'true'),
  def('FINDMYREMOTE_ENABLED', 'Sources', 'boolean', 'Enable FindMyRemote scraper', 'true'),
  def('THESMARTJOBS_ENABLED', 'Sources', 'boolean', 'Enable Smart Jobs scraper', 'true'),
  def('FOURDAYWEEK_ENABLED', 'Sources', 'boolean', 'Enable 4dayweek.io scraper', 'true'),
  def('WEWORKREMOTELY_ENABLED', 'Sources', 'boolean', 'Enable We Work Remotely scraper', 'true'),
  def('REMOTELEAF_ENABLED', 'Sources', 'boolean', 'Enable RemoteLeaf scraper', 'true'),
  def('ATS_AGGREGATOR_ENABLED', 'Sources', 'boolean', 'Enable ATS company-page aggregator', 'true'),
  def(
    'LINKEDIN_SCOUT_RELAY_ENABLED',
    'Sources',
    'boolean',
    'Drain linkedin_scout pending candidates into hunt',
    'true',
  ),
  def('TELEGRAM_CHANNELS_ENABLED', 'Sources', 'boolean', 'Enable Telegram channels source', 'true'),
  def(
    'TELEGRAM_CHANNELS_DELAY_SEC',
    'Sources',
    'number',
    'Pause between Telegram channel fetches (seconds)',
    '1.5',
  ),

  // ── Schedule ──────────────────────────────────────────────────────────────
  def(
    'SCHEDULE_SOURCE_OFFSET_MIN',
    'Schedule',
    'number',
    'Minutes between staggered per-source hunt slots',
    '40',
  ),
  def(
    'RETRY_FAILED_TIMES',
    'Schedule',
    'list',
    'HH:MM times (Warsaw) to retry FAILED tracker rows',
    '07:45,18:45',
  ),
  def(
    'EMAIL_RESPONSE_CHECK_TIME',
    'Schedule',
    'string',
    'Daily confirmation-check time (Warsaw HH:MM)',
    '09:00',
  ),
  def('EXPIRED_CHECK_TIME', 'Schedule', 'string', 'Daily expired-check time (Warsaw HH:MM)', '00:00'),
  def(
    'GDRIVE_UPLOAD_MISSING_INTERVAL_MIN',
    'Schedule',
    'number',
    'How often to backfill missed Drive uploads (minutes)',
    '30',
  ),

  // ── Resilience ────────────────────────────────────────────────────────────
  def('APPLY_DELAY_SEC', 'Resilience', 'number', 'Delay between applies in a batch (seconds)', '30'),
  def('MAX_JOBS_PER_RUN', 'Resilience', 'number', 'Max jobs processed per hunt/apply run', '40'),
  def('APPLY_AGENT_TIMEOUT_SEC', 'Resilience', 'number', 'Wall-clock timeout for API apply agent', '900'),
  def(
    'APPLY_AGENT_CLI_TIMEOUT_SEC',
    'Resilience',
    'number',
    'Wall-clock timeout when CLI mode may be used',
    '2700',
  ),
  def(
    'DUAL_SHADOW_TIMEOUT_SEC',
    'Resilience',
    'number',
    'Hard timeout for detached dual-shadow run',
    '1800',
  ),
  def('CLI_MAX_RETRIES', 'Resilience', 'number', 'Max Claude CLI retries on transient failure', '5'),
  def('CLI_RETRY_DELAY', 'Resilience', 'number', 'Seconds between CLI retries', '60'),
  def(
    'APPLY_QUEUE_ENABLED',
    'Resilience',
    'boolean',
    'Split hunt from apply via PENDING queue',
    'false',
  ),
  def(
    'APPLY_CLAIM_TIMEOUT_MIN',
    'Resilience',
    'number',
    'Minutes before a stuck IN_PROGRESS claim resets to PENDING',
    '60',
  ),
  def(
    'LLM_OUTAGE_PAUSE_MIN',
    'Resilience',
    'number',
    'Minutes to pause auto-apply after an LLM outage',
    '60',
  ),

  // ── Google Sheets ─────────────────────────────────────────────────────────
  def('GSHEETS_ENABLED', 'Google Sheets', 'boolean', 'Sync tracker with Google Sheets', 'false'),
  def('GSHEETS_TRACKER_ID', 'Google Sheets', 'string', 'Google Spreadsheet ID', ''),
  def(
    'GSHEETS_REFRESH_INTERVAL_MIN',
    'Google Sheets',
    'number',
    'Minutes between Sheets → local pulls',
    '30',
  ),

  // ── Google Drive ──────────────────────────────────────────────────────────
  def('GDRIVE_ENABLED', 'Google Drive', 'boolean', 'Upload application folders to Google Drive', 'false'),
  def('GDRIVE_ROOT_FOLDER_ID', 'Google Drive', 'string', 'Existing Drive folder ID (skips auto-create)', ''),
  def('GDRIVE_ROOT_FOLDER_NAME', 'Google Drive', 'string', 'Root folder name when auto-creating', 'Job Hunter'),
  def(
    'GDRIVE_HTTP_TIMEOUT_SEC',
    'Google Drive',
    'number',
    'Socket timeout for Drive HTTP client',
    '60',
  ),

  // ── Gmail ─────────────────────────────────────────────────────────────────
  def('GMAIL_ENABLED', 'Gmail', 'boolean', 'Read job-alert emails from Gmail', 'false'),
  def('GMAIL_LOOKBACK_HOURS', 'Gmail', 'number', 'How far back to scan inbox (hours)', '25'),
  def('GMAIL_MAX_RESULTS', 'Gmail', 'number', 'Max alert emails fetched per scan', '100'),
  def('GMAIL_ENRICH_ENABLED', 'Gmail', 'boolean', 'Fetch real title/company for alert URLs', 'true'),
  def('GMAIL_ENRICH_CONCURRENCY', 'Gmail', 'number', 'Max parallel enrichment HTTP requests', '5'),
  def('GMAIL_ENRICH_TIMEOUT', 'Gmail', 'number', 'Per-job enrichment HTTP timeout (seconds)', '15'),
  def('GMAIL_ENRICH_DOMAIN_LIMIT', 'Gmail', 'number', 'Default per-host concurrency during enrichment', '2'),
  def('GMAIL_ENRICH_DOMAIN_DELAY', 'Gmail', 'number', 'Default delay between same-host enrichment requests', '0.0'),
  def('GMAIL_LABEL_PROCESSED', 'Gmail', 'boolean', 'Label processed alert emails in Gmail', 'true'),
  def(
    'GMAIL_ENRICH_SKIP_HOSTS',
    'Gmail',
    'list',
    'Hosts skipped during enrichment (comma-separated)',
    'linkedin.com,pracuj.pl',
  ),
  def('PRACUJ_HOST_CONCURRENCY', 'Gmail', 'number', 'Max concurrent requests to pracuj.pl', '2'),
  def('PRACUJ_HOST_DELAY_SEC', 'Gmail', 'number', 'Delay between pracuj.pl requests (seconds)', '1.0'),
  def(
    'EMAIL_RESPONSE_LOOKBACK_DAYS',
    'Gmail',
    'number',
    'Default look-back for /check_responses',
    '2',
  ),

  // ── Health ────────────────────────────────────────────────────────────────
  def('SOURCE_HEALTH_ENABLED', 'Health', 'boolean', 'Track per-source yield and alert on dry runs', 'true'),
  def(
    'SOURCE_HEALTH_ALERT_STREAK',
    'Health',
    'number',
    'Consecutive zero/error runs before alerting',
    '3',
  ),
  def('SOURCE_HEALTH_KEEP', 'Health', 'number', 'Rows retained per source (ring buffer)', '50'),
  def('EXPIRED_CHECK_CONCURRENCY', 'Health', 'number', 'Global max parallel expired-check requests', '10'),
  def('EXPIRED_CHECK_DOMAIN_LIMIT', 'Health', 'number', 'Max simultaneous requests per domain', '2'),
  def(
    'EXPIRED_CHECK_DOMAIN_DELAY',
    'Health',
    'number',
    'Delay between same-domain expired checks (seconds)',
    '1.0',
  ),
  def(
    'EXPIRED_CHECK_FETCH_TIMEOUT',
    'Health',
    'number',
    'Hard timeout per expired-check URL fetch (seconds)',
    '35.0',
  ),

  // ── Backup ────────────────────────────────────────────────────────────────
  def('TRACKER_BACKUP_ENABLED', 'Backup', 'boolean', 'Daily snapshot of tracker workbook/DB', 'true'),
  def('TRACKER_BACKUP_DIR', 'Backup', 'string', 'Directory for tracker backups', 'backups'),
  def('TRACKER_BACKUP_KEEP_FILES', 'Backup', 'number', 'Max backup files to retain', '90'),
  def('TRACKER_BACKUP_TIME', 'Backup', 'string', 'Daily backup time (Warsaw HH:MM)', '06:05'),

  // ── Paths ─────────────────────────────────────────────────────────────────
  def('APPLICATIONS_DIR', 'Paths', 'string', 'Root folder for generated application docs', 'Applications'),
  def(
    'TELEGRAM_CHANNELS_FILE',
    'Paths',
    'string',
    'JSON file listing Telegram channels to scrape',
    'telegram_channels.json',
  ),
  def('SOFFICE_PATH', 'Paths', 'string', 'LibreOffice binary path for PDF conversion', 'libreoffice'),
];
