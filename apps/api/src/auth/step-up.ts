// Auth + step-up middleware (Hono).
//
// `authMiddleware` populates `c.get('auth')` with the validated session
// or returns 401. `requireStepUp` runs AFTER auth and returns
// 401 + WWW-Authenticate: StepUp when the step-up window has lapsed.
//
// Cookie names per ADR-0001:
//   __Host-access  — short-lived EdDSA JWT
//   __Host-refresh — opaque base64url (lives on /api/auth only)
//
// `__Host-` prefix demands Path=/, Secure, no Domain. The web app and
// the API are same-origin in production (Fly routes both under one
// hostname); this is enforced by the deployment.md runbook.

import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { validateAccess, type ValidatedAccess } from './session';

// __Host- forces Path=/ at the browser layer; the access cookie wants
// site-wide coverage so it qualifies. Refresh is path-scoped to
// /api/auth, which the __Host- prefix would reject, so it uses
// __Secure- — same Secure-only guarantee without the Path=/ constraint.
export const ACCESS_COOKIE = '__Host-access';
export const REFRESH_COOKIE = '__Secure-refresh';

declare module 'hono' {
  // Augment Hono's variables so c.get('auth') is typed everywhere.
  interface ContextVariableMap {
    auth: ValidatedAccess;
  }
}

export function authMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const token = getCookie(c, ACCESS_COOKIE);
    if (!token) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    const validated = await validateAccess(token);
    if (!validated) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    c.set('auth', validated);
    await next();
    return undefined;
  };
}

export interface RequireStepUpOptions {
  /** Identifier of the action being protected (logged + sent to client). */
  readonly action: string;
  /**
   * Maximum age of the step-up grant for THIS action. When the window
   * is shorter than the session's `step_up_until`, this still gates.
   * Default 5 min (ADR-0001). Sensitive endpoints (e.g. exports) pass
   * 60_000 to require a fresh step-up immediately.
   */
  readonly maxAgeSeconds?: number;
}

export function requireStepUp(opts: RequireStepUpOptions): MiddlewareHandler {
  return async (c, next) => {
    const auth = c.get('auth') as ValidatedAccess | undefined;
    if (!auth) {
      // Programmer error — authMiddleware must run first.
      return c.json({ error: 'unauthorized' }, 401);
    }
    const now = Date.now();
    const stepUpUntilMs = auth.stepUpUntil?.getTime() ?? 0;
    const cap = opts.maxAgeSeconds ?? 5 * 60;
    const oldest = now - cap * 1000;
    // The grant must be present AND it must have been issued no longer
    // than `cap` seconds ago. We approximate "issued at" by working
    // backward from `step_up_until` using the default 5-min window.
    // For shorter `cap` overrides on sensitive endpoints, this floor
    // forces the user to re-step-up.
    const grantIssuedAt = stepUpUntilMs - 5 * 60 * 1000;
    if (stepUpUntilMs < now || grantIssuedAt < oldest) {
      c.header(
        'WWW-Authenticate',
        `StepUp realm="jhsc", action="${opts.action}", max_age="${cap}"`,
      );
      return c.json({ error: 'step_up_required', action: opts.action }, 401);
    }
    await next();
    return undefined;
  };
}

// Helper for routes that want to read the auth context without going
// through the middleware (e.g. optional-auth endpoints).
export function getAuth(c: Context): ValidatedAccess | undefined {
  return c.get('auth') as ValidatedAccess | undefined;
}
