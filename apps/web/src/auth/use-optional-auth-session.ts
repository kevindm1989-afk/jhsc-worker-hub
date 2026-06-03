// Optional read of the AuthContext session — returns null when the
// component is rendered outside an AuthProvider (e.g. unit tests that
// render a single view without the full app shell).
//
// Production code that REQUIRES the session should keep using
// `useAuth()` from auth-context.tsx (the strict variant). This helper
// is for surfaces (action-item-detail-view, etc.) that gracefully
// degrade when no session is present.

import { useContext } from 'react';
import { AuthContext } from './auth-context';
import type { SessionInfo } from './api';

export function useOptionalAuthSession(): SessionInfo | null {
  const ctx = useContext(AuthContext);
  return ctx?.session ?? null;
}
