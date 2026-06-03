# syntax=docker/dockerfile:1.7
#
# Multi-stage build for apps/web (React PWA). Build context is the
# repo root because the web depends on workspace packages
# (@jhsc/excel-import, @jhsc/shared-types, @jhsc/ui).
#
# Build: `docker build -f apps/web/Dockerfile .` from the repo root.
#
# Stage 1 (builder): Node 20 alpine + pnpm — produces dist/ via `pnpm
# build`. The build runs typecheck → vite build so the image only
# ships when the type-check passes (CLAUDE.md "TypeScript strict.").
#
# Stage 2 (runtime): nginx alpine — serves dist/ with SPA-friendly
# fallback (every unmatched route returns /index.html so client-side
# routing works) + gzip + correct MIME for the service-worker file.
#
# S5 F-R-GAP-2: this file did not exist before; the web tier could not
# deploy via Fly Machine without it. Companion to apps/web/fly.toml.

FROM node:20-alpine AS builder
WORKDIR /repo

# Install pnpm pinned to packageManager from the repo root.
RUN npm install -g pnpm@9.12.0

# Copy workspace plumbing first so `pnpm install` can hit the cache
# layer when source files change but deps do not.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./

# Copy the package manifests the web transitively needs. The deps step
# only requires manifests (not src); src lands in the build stage.
COPY apps/web/package.json apps/web/
COPY packages/excel-import/package.json packages/excel-import/
COPY packages/shared-types/package.json packages/shared-types/
COPY packages/ui/package.json packages/ui/

# Install only the web's dep graph. Ignore scripts (husky's prepare
# hook needs a git repo; the image is shipped without .git).
RUN pnpm install --frozen-lockfile --filter @jhsc/web... --ignore-scripts

# Bring in the source we need to build.
COPY apps/web apps/web
COPY packages/excel-import packages/excel-import
COPY packages/shared-types packages/shared-types
COPY packages/ui packages/ui

# Build the static SPA bundle. `pnpm build` runs `tsc --noEmit` (strict
# type-check) followed by `vite build` (writes apps/web/dist/).
RUN pnpm --filter @jhsc/web build

FROM nginx:1.27-alpine AS runtime

# SPA-friendly nginx config: fall through to /index.html for
# client-side routes, serve the service-worker at root scope, gzip
# text assets.
RUN rm /etc/nginx/conf.d/default.conf
COPY <<'NGINX' /etc/nginx/conf.d/default.conf
server {
    listen 8080 default_server;
    listen [::]:8080 default_server;
    server_name _;

    root /usr/share/nginx/html;
    index index.html;

    # The service worker MUST be served from root scope so it can
    # control / paths. vite-plugin-pwa writes it as service-worker.js
    # at the dist root.
    location = /service-worker.js {
        add_header Cache-Control "no-cache";
        add_header Service-Worker-Allowed "/";
        try_files $uri =404;
    }

    # Precached static assets (hashed filenames) — far-future cache.
    location /assets/ {
        add_header Cache-Control "public, max-age=31536000, immutable";
        try_files $uri =404;
    }

    # SPA fallback — any unmatched route returns index.html so React
    # Router can resolve client-side.
    location / {
        add_header Cache-Control "no-cache";
        try_files $uri $uri/ /index.html;
    }

    gzip on;
    gzip_types text/plain text/css application/javascript application/json image/svg+xml;
    gzip_min_length 1024;
}
NGINX

COPY --from=builder /repo/apps/web/dist /usr/share/nginx/html

EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
