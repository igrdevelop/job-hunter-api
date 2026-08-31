export default () => ({
  jwt: { secret: process.env.JWT_SECRET },
  app: {
    dbPath: process.env.APP_DB_PATH || './data/app.sqlite',
    registrationEnabled: process.env.REGISTRATION_ENABLED === 'true',
  },
  // docs/PROFILE_PAGE_TABS.md T3: the single owner whose id gates the
  // owner-only site UI (isOwner on /auth/me) — the same identity
  // DEFAULT_USER_ID names on the bot side. Unset in a fresh/dev deployment
  // (isOwner is then always false) until set once the owner's real user id
  // is known.
  owner: { userId: process.env.OWNER_USER_ID || '' },
  tracker: { dbPath: process.env.TRACKER_DB_PATH || './data/tracker.db' },
  // Per-user storage root: users/{userId}/{candidate,Applications,templates}/
  users: { root: process.env.USERS_ROOT || './data/users' },
  // Bot .env (read-only settings page). Mounted from the bot project in prod.
  bot: { envPath: process.env.BOT_ENV_PATH || './data/.env' },
  mail: {
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT, 10) : 587,
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.SMTP_FROM,
    baseUrl: process.env.APP_BASE_URL || 'https://job-hunter.igrflex.work',
  },
  seed: {
    email: process.env.SEED_USER_EMAIL,
    password: process.env.SEED_USER_PASSWORD,
  },
});
