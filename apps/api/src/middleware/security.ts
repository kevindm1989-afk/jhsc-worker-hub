// Root security middlewares (security-reviewer F1 + F7).
//
// - csrfHeaderGuard rejects any mutating request that does not carry
//   `X-Requested-With: jhsc-web`. The web client always sets it; a
//   simple cross-site form does not. SameSite=Strict on the auth
//   cookies is the primary defense; this is the documented
//   defense-in-depth layer that SECURITY.md §2.1 T-A16 cites.
//
// - securityHeaders applies CSP / HSTS / nosniff / Referrer-Policy /
//   Permissions-Policy / X-Frame-Options at the API root. The API
//   never renders HTML; the CSP is the strictest possible.

import type { MiddlewareHandler } from 'hono';
import { secureHeaders } from 'hono/secure-headers';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const REQUESTED_WITH = 'jhsc-web';

export function csrfHeaderGuard(): MiddlewareHandler {
  return async (c, next) => {
    if (SAFE_METHODS.has(c.req.method)) {
      await next();
      return;
    }
    const header = c.req.header('x-requested-with');
    if (header !== REQUESTED_WITH) {
      return c.json({ error: 'csrf_blocked' }, 403);
    }
    await next();
    return;
  };
}

// Hono's secureHeaders middleware ships sane defaults; we override the
// CSP (the API serves only JSON, no scripts/images), tighten HSTS to
// two-year preload, and lock down Permissions-Policy to the camera/
// microphone/geolocation surfaces the app uses elsewhere.
export const securityHeaders = secureHeaders({
  contentSecurityPolicy: {
    defaultSrc: ["'none'"],
    frameAncestors: ["'none'"],
    baseUri: ["'none'"],
    formAction: ["'none'"],
  },
  strictTransportSecurity: 'max-age=63072000; includeSubDomains; preload',
  xFrameOptions: 'DENY',
  xContentTypeOptions: 'nosniff',
  referrerPolicy: 'no-referrer',
  permissionsPolicy: {
    camera: [],
    microphone: [],
    geolocation: [],
  },
});
