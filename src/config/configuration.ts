export default () => ({
  jwt: { secret: process.env.JWT_SECRET },
  app: {
    dbPath: process.env.APP_DB_PATH || './data/app.sqlite',
    registrationEnabled: process.env.REGISTRATION_ENABLED === 'true',
  },
  tracker: { dbPath: process.env.TRACKER_DB_PATH || './data/tracker.db' },
  // Per-user storage root: users/{userId}/{candidate,Applications,templates}/
  users: { root: process.env.USERS_ROOT || './data/users' },
  // Bot .env (read-only settings page). Mounted from the bot project in prod.
  bot: { envPath: process.env.BOT_ENV_PATH || './data/.env' },
  seed: {
    email: process.env.SEED_USER_EMAIL,
    password: process.env.SEED_USER_PASSWORD,
  },
});
