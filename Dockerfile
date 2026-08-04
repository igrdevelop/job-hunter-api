# syntax=docker/dockerfile:1.4
#
# Build with (from this directory):
#   docker build --build-context frontend=../job-hunter-site -t job-hunter-api .
# or via docker-compose.test.yml, which wires the frontend context automatically.

# ---- Stage 1: build the Angular frontend (job-hunter-site) ----
FROM node:22-alpine AS frontend-build
WORKDIR /app
COPY --from=frontend package*.json ./
RUN npm ci
COPY --from=frontend . .
RUN npm run build

# ---- Stage 2: build the NestJS backend ----
FROM node:22-alpine AS backend-build
# better-sqlite3 compiles a native addon at install time.
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
RUN npm prune --omit=dev

# ---- Stage 3: production image ----
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=backend-build /app/dist ./dist
COPY --from=backend-build /app/node_modules ./node_modules
COPY --from=backend-build /app/package.json ./package.json
COPY --from=frontend-build /app/dist/job-hunter-site/browser ./public
EXPOSE 3000
CMD ["node", "dist/main.js"]
