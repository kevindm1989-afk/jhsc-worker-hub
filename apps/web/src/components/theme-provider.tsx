import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export type Theme = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export interface ThemeContextValue {
  /** The user's stored preference. */
  theme: Theme;
  /** What's actually applied (system resolves to light or dark). */
  resolvedTheme: ResolvedTheme;
  /** Persist a new preference and update the DOM. */
  setTheme: (next: Theme) => void;
}

const STORAGE_KEY = 'jhsc:theme';
const ThemeContext = createContext<ThemeContextValue | null>(null);

function isTheme(v: string | null): v is Theme {
  return v === 'light' || v === 'dark' || v === 'system';
}

function readStoredTheme(): Theme {
  if (typeof window === 'undefined') return 'system';
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isTheme(stored) ? stored : 'system';
  } catch {
    return 'system';
  }
}

function systemPrefersDark(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function resolve(theme: Theme): ResolvedTheme {
  if (theme === 'system') return systemPrefersDark() ? 'dark' : 'light';
  return theme;
}

function applyResolvedToDom(resolved: ResolvedTheme): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-theme', resolved);
}

export function ThemeProvider({ children }: { children: ReactNode }): JSX.Element {
  const [theme, setThemeState] = useState<Theme>(() => readStoredTheme());
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() => resolve(theme));

  // Apply theme to <html data-theme> whenever the user's choice changes.
  useEffect(() => {
    const next = resolve(theme);
    setResolvedTheme(next);
    applyResolvedToDom(next);
  }, [theme]);

  // Subscribe to system preference changes only while theme === 'system'.
  useEffect(() => {
    if (theme !== 'system') return;
    if (typeof window === 'undefined') return;

    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (): void => {
      const next: ResolvedTheme = mq.matches ? 'dark' : 'light';
      setResolvedTheme(next);
      applyResolvedToDom(next);
    };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // localStorage may be unavailable (private browsing, blocked).
      // The in-memory state still flips so the app remains usable.
    }
    setThemeState(next);
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, resolvedTheme, setTheme }),
    [theme, resolvedTheme, setTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme must be used inside <ThemeProvider>');
  }
  return ctx;
}
