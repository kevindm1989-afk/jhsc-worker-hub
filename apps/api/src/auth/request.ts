// Per-request helpers: client IP and User-Agent extraction.
//
// Fly.io terminates TLS at its edge and forwards via Fly-Client-IP.
// Behind nginx/caddy the convention is X-Forwarded-For. We accept both
// and pick the first plausible value.

import type { Context } from 'hono';

export function clientIp(c: Context): string | null {
  const fly = c.req.header('fly-client-ip');
  if (fly) return fly.trim();
  const xff = c.req.header('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first && first.length > 0) return first;
  }
  return null;
}

export function userAgent(c: Context): string | null {
  const ua = c.req.header('user-agent');
  if (!ua) return null;
  // Cap length defensively — UA strings can be abusive.
  return ua.slice(0, 512);
}
