export default () => ({
  jwt: { secret: process.env.JWT_SECRET },
  app: { dbPath: process.env.APP_DB_PATH || './data/app.sqlite' },
  tracker: { dbPath: process.env.TRACKER_DB_PATH || './data/tracker.db' },
  // Bot-generated CVs / cover letters (Applications/{date}/{company}/).
  files: { path: process.env.FILES_PATH || './data/Applications' },
  // Personal candidate assets (YAML, base CV, notes) — also template uploads.
  candidate: { path: process.env.CANDIDATE_PATH || './data/candidate' },
  // Bot .env (read-only settings page). Mounted from the bot project in prod.
  bot: { envPath: process.env.BOT_ENV_PATH || './data/.env' },
  seed: {
    email: process.env.SEED_USER_EMAIL,
    password: process.env.SEED_USER_PASSWORD,
  },
});
