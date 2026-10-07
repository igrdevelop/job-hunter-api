# syntax=docker/dockerfile:1.4
#
# Standalone backend image â€” API only. The Angular frontend is built and
# deployed independently from the job-hunter-site repo.

# ---- Stage 1: build ----
FROM node:22-alpine AS build
# better-sqlite3 compiles a native addon at install time.
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
RUN npm prune --omit=dev

# ---- Stage 2: production image ----
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
# Run as the image's built-in `node` user (uid/gid 1000), NOT root. The bot
# container runs as its own `hunter` user with the SAME uid 1000 (bot
# Dockerfile, since 2026-09-10), and both containers write into the same host
# directories: ./users (per-user candidate/Applications/templates trees —
# mounted here as /app/data/users) and ./db (tracker.db + its -wal/-shm
# sidecars — /app/data/db). As root this API created root-owned 0755
# directories and 0644 files there, which the bot then could not write into:
# every profile render/preview job failed with `[Errno 13] Permission denied:
# '/app/users/<uid>/candidate/candidate.yaml'` (live smoke red from
# 2026-09-14). One uid on both sides means the default umask (022) is enough —
# no group-write or shared-gid scheme is needed.
#
# /app/data is created and handed to `node` so the relative defaults in
# src/config/configuration.ts (./data/app.sqlite, ./data/tracker.db,
# ./data/users) stay writable when nothing is mounted over them. In prod every
# one of those paths is a host bind mount, whose ownership comes from the
# HOST, not from this image — see the owner runbook in the PR that added this
# (`chown -R 1000:1000` on the mounted dirs). Pinned by
# test/dockerfile-user.e2e-spec.ts. Port 3000 is unprivileged, so no
# capability is needed to bind it.
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
