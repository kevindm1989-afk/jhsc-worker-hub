# syntax=docker/dockerfile:1.7
#
# Monorepo-context Bun image for apps/api. Build context is the repo
# root because the api now depends on workspace packages (@jhsc/audit,
# @jhsc/crypto, @jhsc/legal-corpus, @jhsc/shared-types). The earlier
# per-app context flipped here when Milestone 1.3+ wired those deps.
#
# Build: `docker build -f apps/api/Dockerfile .` from the repo root.

FROM oven/bun:1-alpine AS deps
WORKDIR /repo

# Install pnpm — the workspace's package manager. Pinned to match
# `packageManager` in the repo root package.json so the lockfile
# resolution is deterministic across local + CI builds.
RUN apk add --no-cache nodejs npm && npm install -g pnpm@9.12.0

# Copy workspace plumbing first so `pnpm install` can hit the cache
# layer when source files change but deps do not.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./

# Copy the package manifests the api transitively needs. The deps step
# only requires manifests (not src); src lands in the runtime stage.
COPY apps/api/package.json apps/api/
COPY packages/audit/package.json packages/audit/
COPY packages/crypto/package.json packages/crypto/
COPY packages/legal-corpus/package.json packages/legal-corpus/
COPY packages/shared-types/package.json packages/shared-types/

# Install only the api's dep graph. Ignore scripts (husky's prepare
# hook needs a git repo; the image is shipped without .git).
RUN pnpm install --frozen-lockfile --filter @jhsc/api... --ignore-scripts

FROM oven/bun:1-alpine AS runtime
WORKDIR /repo
RUN apk add --no-cache nodejs npm && npm install -g pnpm@9.12.0

# Bring in the workspace tree from deps + the source we need to run.
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/apps/api/node_modules ./apps/api/node_modules
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./

COPY apps/api/package.json apps/api/tsconfig.json apps/api/
COPY apps/api/src apps/api/src

COPY packages/audit packages/audit
COPY packages/crypto packages/crypto
COPY packages/legal-corpus packages/legal-corpus
COPY packages/shared-types packages/shared-types

RUN addgroup -S app && adduser -S app -G app && chown -R app:app /repo
USER app
EXPOSE 3001
WORKDIR /repo/apps/api
CMD ["bun", "run", "src/index.ts"]
