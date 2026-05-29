import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeAll, vi } from 'vitest';

// Default fetch mock for the auth surface — keeps the app-shell tests
// rendering the authenticated state without spinning up a real backend.
// Individual tests can override per-call via `vi.spyOn(globalThis,
// 'fetch')` if they need different behavior.
function defaultAuthFetch(input: RequestInfo | URL): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.endsWith('/api/auth/first-run/status')) {
    return Promise.resolve(
      new Response(JSON.stringify({ completed: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }
  if (url.endsWith('/api/auth/session')) {
    return Promise.resolve(
      new Response(
        JSON.stringify({
          userId: 'test-user',
          displayName: 'Test User',
          sessionId: 'test-session',
          stepUp: { active: false, until: null },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
  }
  return Promise.resolve(new Response(null, { status: 404 }));
}

// jsdom does not ship a matchMedia implementation. ThemeProvider depends
// on it, so without this polyfill any test that renders <App /> throws.
// `matches: false` makes the "system" theme resolve to light by default
// in tests — matching what most test runners assume.

beforeAll(() => {
  if (typeof window.matchMedia !== 'function') {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }),
    });
  }
  vi.stubGlobal('fetch', vi.fn(defaultAuthFetch));
});

// Test isolation:
// - cleanup() unmounts the previous test's RTL roots
// - localStorage is cleared so theme preferences do not leak
// - data-theme is removed from <html> so the next test sees a clean DOM
// - history is reset so BrowserRouter starts each test at "/"
afterEach(() => {
  cleanup();
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  window.history.replaceState({}, '', '/');
});
