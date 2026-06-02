// Global auth state — first-run-completed gate + current-session lookup.
//
// On boot we fetch /first-run/status and /session (best-effort) in
// parallel. A 401 on /session is the expected "not signed in" path.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { ApiError, api, type SessionInfo } from './api';
import { clearOnLogout } from '@/sync/db';
import { getWorker, setWorkerForTests } from '@/sync/worker-singleton';

export type BootState = 'loading' | 'ready' | 'error';

export interface AuthState {
  readonly boot: BootState;
  readonly firstRunCompleted: boolean;
  readonly session: SessionInfo | null;
  readonly refresh: () => Promise<void>;
  readonly setSession: (s: SessionInfo | null) => void;
  readonly logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const [boot, setBoot] = useState<BootState>('loading');
  const [firstRunCompleted, setFirstRunCompleted] = useState(false);
  const [session, setSession] = useState<SessionInfo | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [statusResult, sessionResult] = await Promise.allSettled([
        api.firstRun.status(),
        api.session.current(),
      ]);
      if (statusResult.status === 'fulfilled') {
        setFirstRunCompleted(statusResult.value.completed);
      } else {
        // Status is supposed to be public; failure here is a real outage.
        setBoot('error');
        return;
      }
      if (sessionResult.status === 'fulfilled') {
        setSession(sessionResult.value);
      } else {
        if (sessionResult.reason instanceof ApiError && sessionResult.reason.status === 401) {
          setSession(null);
        } else {
          // Treat unexpected /session failures as "no session" rather than
          // error-page the whole app — login still works.
          setSession(null);
        }
      }
      setBoot('ready');
    } catch {
      setBoot('error');
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the setState calls inside refresh() fire only after the fetch resolves on a later tick; this is the standard "boot the auth state once on mount" pattern and matches how theme-provider seeds itself
    void refresh();
  }, [refresh]);

  const logout = useCallback(async (): Promise<void> => {
    try {
      await api.session.logout();
    } catch {
      // best-effort
    }
    // sec-F9 close-out (T-S56): tear down the per-session Dexie state
    // (sync_queue, sync_conflicts, _base_state, legal_clauses,
    // inspection_templates) so a subsequent rep on the same device
    // doesn't inherit queued ops bound to the prior actor. Best-
    // effort: a failure to clear shouldn't block the logout UX.
    try {
      // Stop the queue worker BEFORE clearing the queue, otherwise an
      // in-flight drain can race the clear and emit a partial state.
      getWorker().stop();
      await clearOnLogout();
    } catch {
      // best-effort
    }
    // Drop the queue worker singleton so the next login builds a
    // fresh one bound to the new auth context.
    setWorkerForTests(null);
    setSession(null);
  }, []);

  const value = useMemo<AuthState>(
    () => ({ boot, firstRunCompleted, session, refresh, setSession, logout }),
    [boot, firstRunCompleted, session, refresh, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
