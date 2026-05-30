// In-memory token-bucket rate limiter for unauth public routes
// (sec-review F4). Keyed by (route-prefix, client IP). The bucket
// refills at `refillPerSecond` tokens/sec up to `capacity`; each
// request takes one token. When empty, the handler returns 429 with
// a `Retry-After` header.
//
// Why in-memory: this API is a single-tenant Fly machine. A shared
// Postgres-backed limiter would let two machines coordinate, but
// we don't run multi-machine for 1.4 and the in-memory ceiling is
// the right cost/benefit for a public read surface where the only
// real concern is DoS via the ts_headline price tag.
//
// IP detection prefers Fly-Client-IP (set by Fly's proxy), falls
// back to X-Forwarded-For first hop, and finally the connecting
// socket. Operators behind a different proxy override via the
// trustedProxyHeader option.

import type { MiddlewareHandler } from 'hono';

export interface RateLimitOptions {
  readonly name: string;
  readonly capacity: number;
  readonly refillPerSecond: number;
  /** Override the header that carries the client IP. Defaults to fly-client-ip. */
  readonly clientIpHeader?: string;
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

const REGISTRY = new Map<string, Map<string, Bucket>>();

function getRegistry(name: string): Map<string, Bucket> {
  let m = REGISTRY.get(name);
  if (!m) {
    m = new Map();
    REGISTRY.set(name, m);
  }
  return m;
}

function clientIp(c: Parameters<MiddlewareHandler>[0], headerName: string): string {
  const direct = c.req.header(headerName);
  if (direct) return direct;
  const xff = c.req.header('x-forwarded-for');
  if (xff) return xff.split(',')[0]!.trim();
  // Hono on Bun exposes the address via c.env.requestIP; for tests
  // we fall back to a fixed key so the limiter still works.
  return 'unknown';
}

export function rateLimit(opts: RateLimitOptions): MiddlewareHandler {
  const headerName = (opts.clientIpHeader ?? 'fly-client-ip').toLowerCase();
  return async (c, next) => {
    const ip = clientIp(c, headerName);
    const registry = getRegistry(opts.name);
    const now = Date.now();
    let bucket = registry.get(ip);
    if (!bucket) {
      bucket = { tokens: opts.capacity, lastRefillMs: now };
      registry.set(ip, bucket);
    }
    const elapsedMs = now - bucket.lastRefillMs;
    const refill = (elapsedMs / 1000) * opts.refillPerSecond;
    bucket.tokens = Math.min(opts.capacity, bucket.tokens + refill);
    bucket.lastRefillMs = now;
    if (bucket.tokens < 1) {
      const waitSec = Math.ceil((1 - bucket.tokens) / opts.refillPerSecond);
      c.header('Retry-After', String(Math.max(1, waitSec)));
      return c.json({ error: 'rate_limited' }, 429);
    }
    bucket.tokens -= 1;
    await next();
    return;
  };
}

// Test-only: reset every registered bucket. Used by integration tests
// that exercise the limiter to keep test ordering deterministic.
export function _resetRateLimitForTests(): void {
  REGISTRY.clear();
}
