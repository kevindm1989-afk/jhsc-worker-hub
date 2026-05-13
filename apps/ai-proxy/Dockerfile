# syntax=docker/dockerfile:1.7
#
# Two-stage Bun image. Build context is apps/ai-proxy/ for now — no
# workspace package deps yet. When the proxy starts importing @jhsc/*
# packages the context will flip to the repo root.

FROM oven/bun:1-alpine AS deps
WORKDIR /app
COPY package.json ./
# TODO Group F (Milestone 1.1 CI): switch to --frozen-lockfile with a committed
# bun.lockb, or flip to pnpm with root-context build.
RUN bun install --production

FROM oven/bun:1-alpine AS runtime
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --chown=bun:bun package.json ./
COPY --chown=bun:bun tsconfig.json ./
COPY --chown=bun:bun src ./src
USER bun
EXPOSE 3002
CMD ["bun", "run", "src/index.ts"]
