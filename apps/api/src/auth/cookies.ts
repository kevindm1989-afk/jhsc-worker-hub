// Cookie helpers — centralizes the __Host-* flag set so every issue
// site agrees with every clear site. The web app reads NEITHER cookie
// (HttpOnly); the browser attaches them automatically on same-origin
// requests.

import type { Context } from 'hono';
import { setCookie, deleteCookie } from 'hono/cookie';
import { ACCESS_COOKIE, REFRESH_COOKIE } from './step-up';

interface IssuedTokens {
  readonly accessJwt: string;
  readonly refreshToken: string;
  readonly refreshExpiresAt: Date;
}

const ACCESS_MAX_AGE_SECONDS = 30 * 60; // matches the JWT exp.

export function setAuthCookies(c: Context, tokens: IssuedTokens): void {
  // Access cookie — site-wide so any /api/* call carries it.
  setCookie(c, ACCESS_COOKIE, tokens.accessJwt, {
    httpOnly: true,
    secure: true,
    sameSite: 'Strict',
    path: '/',
    maxAge: ACCESS_MAX_AGE_SECONDS,
  });
  // Refresh cookie — scoped to /api/auth so it never rides on a non-auth
  // request. Less attack surface if a future XSS finds a way to provoke
  // a cross-tab request.
  const refreshMaxAge = Math.max(
    1,
    Math.floor((tokens.refreshExpiresAt.getTime() - Date.now()) / 1000),
  );
  setCookie(c, REFRESH_COOKIE, tokens.refreshToken, {
    httpOnly: true,
    secure: true,
    sameSite: 'Strict',
    path: '/api/auth',
    maxAge: refreshMaxAge,
  });
}

export function clearAuthCookies(c: Context): void {
  // Hono's deleteCookie just emits a Max-Age=0 Set-Cookie; the __Host-
  // and __Secure- prefixes still require Secure to be set, so we pass
  // the same flag set the issue path used.
  deleteCookie(c, ACCESS_COOKIE, {
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'Strict',
  });
  deleteCookie(c, REFRESH_COOKIE, {
    path: '/api/auth',
    secure: true,
    httpOnly: true,
    sameSite: 'Strict',
  });
}
