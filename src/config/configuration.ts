export default () => ({
  jwt: { secret: process.env.JWT_SECRET },
  tracker: { dbPath: process.env.TRACKER_DB_PATH || './data/tracker.db' },
  files: { path: process.env.FILES_PATH || './data/Applications' },
  seed: {
    email: process.env.SEED_USER_EMAIL,
    password: process.env.SEED_USER_PASSWORD,
  },
});
