#!/usr/bin/env bash
# migrate-owner-data.sh — run ONCE on the VPS after deploying A2.
#
# Moves the existing single-user candidate/ and Applications/ trees into the
# new per-user layout under USERS_ROOT, keyed by the owner's user id.
#
# Prerequisites:
#   - The A2 container has been deployed at least once (creates app.sqlite with
#     the migrated users table that has the role column).
#   - USERS_ROOT dir exists and is bind-mounted into the container
#     (e.g. /home/deploy/job-hunter/users).
#   - Run as root or a user with write access to both source and destination.
#
# Usage (on the VPS):
#   APP_SQLITE=/home/deploy/job-hunter-web/app-data/app.sqlite \
#   SRC_CANDIDATE=/home/deploy/job-hunter/candidate \
#   SRC_APPLICATIONS=/home/deploy/job-hunter/Applications \
#   USERS_ROOT=/home/deploy/job-hunter/users \
#   bash scripts/migrate-owner-data.sh

set -euo pipefail

APP_SQLITE="${APP_SQLITE:-/home/deploy/job-hunter-web/app-data/app.sqlite}"
SRC_CANDIDATE="${SRC_CANDIDATE:-/home/deploy/job-hunter/candidate}"
SRC_APPLICATIONS="${SRC_APPLICATIONS:-/home/deploy/job-hunter/Applications}"
USERS_ROOT="${USERS_ROOT:-/home/deploy/job-hunter/users}"

# Resolve owner id from app.sqlite.
if ! command -v sqlite3 &>/dev/null; then
  echo "ERROR: sqlite3 not found. Install it: apt install sqlite3" >&2
  exit 1
fi

OWNER_ID=$(sqlite3 "$APP_SQLITE" "SELECT id FROM users WHERE role='admin' LIMIT 1;")
if [ -z "$OWNER_ID" ]; then
  echo "ERROR: no admin user found in $APP_SQLITE" >&2
  exit 1
fi

echo "Owner user id: $OWNER_ID"
DEST_CANDIDATE="$USERS_ROOT/$OWNER_ID/candidate"
DEST_APPLICATIONS="$USERS_ROOT/$OWNER_ID/Applications"
DEST_TEMPLATES="$USERS_ROOT/$OWNER_ID/templates"

mkdir -p "$DEST_CANDIDATE" "$DEST_APPLICATIONS" "$DEST_TEMPLATES"

# Move candidate/ (everything except templates/).
if [ -d "$SRC_CANDIDATE" ]; then
  echo "Migrating candidate/ -> $DEST_CANDIDATE"
  for item in "$SRC_CANDIDATE"/*; do
    name=$(basename "$item")
    if [ "$name" = "templates" ]; then
      continue
    fi
    if [ -e "$DEST_CANDIDATE/$name" ]; then
      echo "  SKIP $name (already exists in destination)"
    else
      mv "$item" "$DEST_CANDIDATE/"
      echo "  moved $name"
    fi
  done
fi

# Move candidate/templates/ contents.
SRC_TEMPLATES="$SRC_CANDIDATE/templates"
if [ -d "$SRC_TEMPLATES" ]; then
  echo "Migrating candidate/templates/ -> $DEST_TEMPLATES"
  for item in "$SRC_TEMPLATES"/*; do
    name=$(basename "$item")
    if [ -e "$DEST_TEMPLATES/$name" ]; then
      echo "  SKIP $name (already exists)"
    else
      mv "$item" "$DEST_TEMPLATES/"
      echo "  moved $name"
    fi
  done
fi

# Move Applications/ tree.
if [ -d "$SRC_APPLICATIONS" ]; then
  echo "Migrating Applications/ -> $DEST_APPLICATIONS"
  for item in "$SRC_APPLICATIONS"/*; do
    name=$(basename "$item")
    if [ -e "$DEST_APPLICATIONS/$name" ]; then
      echo "  SKIP $name (already exists)"
    else
      mv "$item" "$DEST_APPLICATIONS/"
      echo "  moved $name"
    fi
  done
fi

echo ""
echo "Done. Verify with:"
echo "  ls $DEST_CANDIDATE"
echo "  ls $DEST_APPLICATIONS"
echo "  ls $DEST_TEMPLATES"
