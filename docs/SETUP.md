# Setup — job-hunter-api

Step-by-step: from empty folder to running NestJS backend.

---

## Step 0: Create the project

```bash
cd D:\LearningProject\job-hunter-api

# Install NestJS CLI globally (if not installed)
npm install -g @nestjs/cli

# Scaffold NestJS project IN the current directory
nest new . --package-manager npm --skip-git

# Initialize git
git init
git add .
git commit -m "Initial NestJS scaffold"
```

## Step 1: Create GitHub repo

```bash
# Create private repo on GitHub (igrdevelop account)
gh repo create igrdevelop/job-hunter-api --private --source=. --remote=origin --push
```

## Step 2: Install core dependencies

```bash
# SQLite (for NestJS own user DB + reading bot's tracker.db)
npm install better-sqlite3
npm install -D @types/better-sqlite3

# Auth
npm install @nestjs/passport passport passport-jwt @nestjs/jwt bcrypt
npm install -D @types/passport-jwt @types/bcrypt

# Validation
npm install class-validator class-transformer

# Config
npm install @nestjs/config

# Serve Angular static files
npm install @nestjs/serve-static
```

## Step 3: Create `.env` file

```bash
cat > .env << 'EOF'
# Auth
JWT_SECRET=generate-a-random-64-char-string-here

# Paths (Docker mounts from bot container)
TRACKER_DB_PATH=./data/tracker.db
FILES_PATH=./data/Applications

# Seed user (owner account, created on first start)
SEED_USER_EMAIL=igrflex@gmail.com
SEED_USER_PASSWORD=change-this-before-deploy
EOF
```

Add `.env` to `.gitignore`:
```bash
echo ".env" >> .gitignore
```

## Step 4: Verify it runs

```bash
npm run start:dev
# Should see: "Nest application successfully started"
# http://localhost:3000 → 404 (no routes yet, that's fine)
```

## Step 5: Continue with IMPLEMENTATION_PLAN.md

The implementation steps (A0-A4) are in `docs/IMPLEMENTATION_PLAN.md`.
