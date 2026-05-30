// Auth-aware router. Decides which top-level surface the user lands on:
//
//   loading              → skeleton splash
//   !firstRunCompleted   → /setup is the only reachable route
//   no session           → /login is the only reachable route
//   authenticated        → the app shell (children)
//
// Bypasses are tight on purpose. Letting a half-authenticated user reach
// /minutes would surface 401s in places that shouldn't even attempt the
// call. The router resolves the destination once at boot; subsequent
// navigation is React Router's job.

import { type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth-context';
import { LoginView } from '../views/login-view';
import { SetupView } from '../views/setup-view';

export function AuthRouter({ children }: { children: ReactNode }): JSX.Element {
  const { boot, firstRunCompleted, session } = useAuth();
  const location = useLocation();

  if (boot === 'loading') {
    return <BootSplash />;
  }
  if (boot === 'error') {
    return <BootError />;
  }

  // Setup gate — only /setup is reachable until the singleton flips.
  if (!firstRunCompleted) {
    return (
      <Routes>
        <Route path="/setup" element={<SetupView />} />
        <Route path="*" element={<Navigate to="/setup" replace />} />
      </Routes>
    );
  }

  // Setup is done — if the user manages to land on /setup, push them to
  // login (or to the app if they're already signed in).
  if (location.pathname === '/setup') {
    return <Navigate to={session ? '/' : '/login'} replace />;
  }

  // Auth gate.
  if (!session) {
    return (
      <Routes>
        <Route path="/login" element={<LoginView />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  // Signed in — fall through to the main app shell.
  return <>{children}</>;
}

function BootSplash(): JSX.Element {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-h-screen items-center justify-center bg-background"
    >
      <div className="flex flex-col items-center gap-3">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-border border-t-accent" />
        <div className="text-sm text-muted-foreground">Loading…</div>
      </div>
    </div>
  );
}

function BootError(): JSX.Element {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="max-w-sm text-center">
        <h1 className="text-xl font-semibold">Can&rsquo;t reach the server</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Check your connection. If the problem persists, the JHSC Worker Hub backend may be
          offline.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-4 inline-flex h-10 items-center rounded-md bg-accent px-4 text-sm font-medium text-accent-foreground"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
