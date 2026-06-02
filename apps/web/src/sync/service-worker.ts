// Service worker (Milestone 1.10 S2, ADR-0009 §3.9).
//
// Consumed by vite-plugin-pwa's `injectManifest` strategy: the plugin
// injects the precache manifest (`__WB_MANIFEST`) at build time; this
// file uses it via workbox-precaching to install the app shell. The
// rest of the SW handles `/api/*` interception:
//
//   - Safe methods (GET/HEAD/OPTIONS): network-first; cache fallback.
//   - Mutating methods on the require-online allow-list: synthetic 503
//     `network_required` (the typed-client wrapper surfaces the banner).
//   - Mutating methods elsewhere: try network with a 5s timeout; on
//     failure, postMessage the foreground (so the queue worker can
//     enqueue the request) and return a synthetic 202 `sw_queued`.
//
// Notes on what the SW does NOT do:
//   - It does NOT read Dexie directly. Dexie runs in the foreground only.
//     The queue worker is a foreground actor.
//   - It does NOT cache Tigris ciphertext or any reveal-endpoint
//     response body (T-S3 — no decrypted plaintext at rest; reveals are
//     live-fetched always).
//   - It does NOT swap controllers mid-session. `registerType: 'auto-
//     Update'` shows a soft-update banner on next visit.

/// <reference lib="webworker" />

// vite-plugin-pwa injects the precache manifest at build time.
declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: ReadonlyArray<{ url: string; revision: string | null }>;
};

import { precacheAndRoute } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import { CacheFirst, NetworkFirst, StaleWhileRevalidate } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';
import { CacheableResponsePlugin } from 'workbox-cacheable-response';

// ---------------------------------------------------------------------------
// Precache the app shell (HTML/JS/CSS) and the bundled icon + font assets
// ---------------------------------------------------------------------------

precacheAndRoute(self.__WB_MANIFEST ?? []);

// ---------------------------------------------------------------------------
// Lucide icons (cache-first; immutable per build hash)
// ---------------------------------------------------------------------------

registerRoute(
  ({ request }: { request: Request }) =>
    request.destination === 'image' && /lucide/i.test(request.url),
  new CacheFirst({
    cacheName: 'jhsc-lucide-v1',
    plugins: [
      new ExpirationPlugin({ maxAgeSeconds: 60 * 60 * 24 * 30, maxEntries: 200 }),
      new CacheableResponsePlugin({ statuses: [0, 200] }),
    ],
  }),
);

// ---------------------------------------------------------------------------
// Source Serif 4 / Inter / JetBrains Mono fonts (cache-first)
// ---------------------------------------------------------------------------

registerRoute(
  ({ request }: { request: Request }) =>
    request.destination === 'font' ||
    /fontsource-variable|source-serif|inter|jetbrains/i.test(request.url),
  new CacheFirst({
    cacheName: 'jhsc-fonts-v1',
    plugins: [
      new ExpirationPlugin({ maxAgeSeconds: 60 * 60 * 24 * 365, maxEntries: 64 }),
      new CacheableResponsePlugin({ statuses: [0, 200] }),
    ],
  }),
);

// ---------------------------------------------------------------------------
// API: same-origin /api/* interception
// ---------------------------------------------------------------------------

/**
 * URL-prefix allow-list of routes that must NOT be queued offline (per
 * ADR §3.6). These are step-up-gated reveals, server-side renders, and
 * the auth lifecycle. The SW returns a synthetic 503 `network_required`
 * for any mutation against these paths when offline.
 *
 * Matching is prefix-based on the URL path. We match against the request
 * pathname directly so a URL param ":id" segment doesn't drift; e.g.
 * `/api/recommendations/abc-123/reveal` matches the
 * `/api/recommendations/` prefix + the suffix `/reveal`.
 */
const REQUIRE_ONLINE_PATTERNS: ReadonlyArray<RegExp> = [
  // Reveals
  /^\/api\/hazards\/[^/]+\/reporter$/,
  /^\/api\/inspections\/findings\/[^/]+$/,
  /^\/api\/recommendations\/[^/]+\/reveal$/,
  /^\/api\/evidence\/[^/]+\/decrypt$/,
  // Exports + downloads
  /^\/api\/recommendations\/[^/]+\/exports$/,
  /^\/api\/recommendations\/exports\/[^/]+\/download$/,
  /^\/api\/inspections\/[^/]+\/exports$/,
  /^\/api\/inspections\/exports\/[^/]+\/download$/,
  /^\/api\/inspections\/exports\/batch$/,
  // Auth lifecycle
  /^\/api\/auth\/step-up\//,
  /^\/api\/auth\/first-run\//,
  /^\/api\/auth\/login\//,
  /^\/api\/auth\/password\//,
  /^\/api\/auth\/passkey\//,
  /^\/api\/auth\/totp\//,
  /^\/api\/auth\/refresh$/,
  /^\/api\/auth\/logout/,
];

/** Network-timeout for the foreground mutation attempt. After this we
 * postMessage the queue + return synthetic 202. */
const MUTATION_TIMEOUT_MS = 5000;

function isRequireOnline(url: URL): boolean {
  return REQUIRE_ONLINE_PATTERNS.some((re) => re.test(url.pathname));
}

function isMutation(method: string): boolean {
  return method === 'POST' || method === 'PATCH' || method === 'DELETE' || method === 'PUT';
}

function syntheticJsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'X-Synthetic-Origin': 'service-worker',
    },
  });
}

self.addEventListener('fetch', (event: FetchEvent) => {
  const req = event.request;
  if (!req.url.startsWith(self.location.origin)) return; // cross-origin: pass-through
  const url = new URL(req.url);
  if (!url.pathname.startsWith('/api/')) return; // app shell handled by precache
  if (!isMutation(req.method)) {
    // Safe method: network-first with cache fallback.
    event.respondWith(
      new NetworkFirst({
        cacheName: 'jhsc-api-reads-v1',
        plugins: [new CacheableResponsePlugin({ statuses: [200] })],
        networkTimeoutSeconds: 4,
      }).handle({ event, request: req }),
    );
    return;
  }
  // Mutation: branch on the require-online allow-list.
  if (isRequireOnline(url)) {
    event.respondWith(handleRequireOnline(req, url));
    return;
  }
  event.respondWith(handleQueueableMutation(req));
});

async function handleRequireOnline(req: Request, url: URL): Promise<Response> {
  try {
    const fresh = await fetchWithTimeout(req, MUTATION_TIMEOUT_MS);
    return fresh;
  } catch {
    return syntheticJsonResponse(503, {
      error: 'network_required',
      path: url.pathname,
    });
  }
}

async function handleQueueableMutation(req: Request): Promise<Response> {
  // Try the network with a 5s timeout. On success: pass through. On
  // failure / timeout: postMessage the foreground + return synthetic
  // 202.
  try {
    const fresh = await fetchWithTimeout(req, MUTATION_TIMEOUT_MS);
    return fresh;
  } catch {
    // Best-effort: notify the foreground so the queue worker can pick
    // this up. The actual queue enqueue happens in the foreground typed-
    // client (the same call that produced this fetch already wrote a
    // Dexie row + a sync_queue row before the fetch fired; this
    // postMessage is a "wake the worker" signal).
    await postMessageToClients({
      kind: 'sw_queued',
      method: req.method,
      url: req.url,
      ts: new Date().toISOString(),
    });
    return syntheticJsonResponse(202, {
      ok: false,
      queued: true,
      info: 'queued by service worker — foreground queue worker will drain',
    });
  }
}

async function fetchWithTimeout(req: Request, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Clone the request so the body stream can be retried by the
    // foreground (the original `req.body` is single-shot).
    const cloned = req.clone();
    const res = await fetch(cloned, { signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function postMessageToClients(payload: unknown): Promise<void> {
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  for (const c of clients) {
    try {
      c.postMessage(payload);
    } catch {
      // Per-client postMessage failures are non-fatal.
    }
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

self.addEventListener('install', () => {
  // `skipWaiting` is intentionally NOT called here. ADR §3.9: we don't
  // silently swap controllers mid-session; the rep gets a soft-update
  // banner on next visit (vite-plugin-pwa registerType: 'autoUpdate'
  // handles the banner).
});

self.addEventListener('activate', (event) => {
  // Clean up old caches on activation.
  event.waitUntil(
    (async () => {
      const cacheNames = await self.caches.keys();
      const keep = new Set([
        'jhsc-lucide-v1',
        'jhsc-fonts-v1',
        'jhsc-api-reads-v1',
        // workbox-precaching internal cache name
        'workbox-precache-v2-' + self.registration.scope,
      ]);
      await Promise.all(
        cacheNames.map((name) =>
          keep.has(name) ? Promise.resolve(true) : self.caches.delete(name),
        ),
      );
      await self.clients.claim();
    })(),
  );
});

// Stale-while-revalidate handler exposed for typing — not currently
// registered, but kept here as a forward seam for the legal-corpus
// snapshot caching once the API surfaces /api/legal/snapshot in 1.10
// (S3 will land that route).
export const _swr = StaleWhileRevalidate;
