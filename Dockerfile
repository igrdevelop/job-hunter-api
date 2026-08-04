# syntax=docker/dockerfile:1.4
#
# Standalone backend image — API only. The Angular frontend is built and
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
EXPOSE 3000
CMD ["node", "dist/main.js"]
