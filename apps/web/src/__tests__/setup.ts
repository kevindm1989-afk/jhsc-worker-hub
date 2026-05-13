import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeAll } from 'vitest';

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
