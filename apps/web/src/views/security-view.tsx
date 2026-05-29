// Account → Security.
//
// 1.2 minimum:
// - List currently registered passkeys (read-only labels)
// - Add a new passkey via @simplewebauthn/browser
// - Sign out everywhere
//
// Defer to a later slice: TOTP reset, recovery-code regeneration,
// per-session list with individual revoke, passkey rename / delete.

import { startRegistration } from '@simplewebauthn/browser';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, api, type PasskeySummary } from '../auth/api';
import { useAuth } from '../auth/auth-context';

export function SecurityView(): JSX.Element {
  const [passkeys, setPasskeys] = useState<ReadonlyArray<PasskeySummary>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [enrolling, setEnrolling] = useState(false);
  const { logout } = useAuth();
  const navigate = useNavigate();

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const { passkeys: list } = await api.passkey.list();
      setPasskeys(list);
      setError(null);
    } catch {
      setError('Could not load passkeys.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- setPasskeys / setError / setLoading fire after the fetch resolves on a later tick; this is the standard "fetch on mount" pattern
    void load();
  }, [load]);

  const addPasskey = async (): Promise<void> => {
    if (enrolling) return;
    setEnrolling(true);
    setError(null);
    try {
      const options = (await api.passkey.registerOptions()) as Parameters<
        typeof startRegistration
      >[0]['optionsJSON'];
      const response = await startRegistration({ optionsJSON: options });
      await api.passkey.registerVerify(response);
      await load();
    } catch (err) {
      if (isUserCancel(err)) {
        setError(null);
      } else if (err instanceof ApiError) {
        setError('Could not register that passkey. Try a different authenticator.');
      } else {
        setError('Could not register a passkey on this device.');
      }
    } finally {
      setEnrolling(false);
    }
  };

  const signOut = async (): Promise<void> => {
    await logout();
    navigate('/login', { replace: true });
  };

  return (
    <div className="px-5 py-6">
      <h1 className="text-xl font-semibold tracking-tight">Security</h1>

      <h2 className="mt-6 text-base font-semibold">Passkeys</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Phishing-resistant sign-in. We recommend at least two.
      </p>

      {loading ? (
        <ul className="mt-3 space-y-2">
          <li className="h-14 animate-pulse rounded-md bg-muted" />
          <li className="h-14 animate-pulse rounded-md bg-muted" />
        </ul>
      ) : passkeys.length === 0 ? (
        <p className="mt-3 rounded-md border border-border bg-card p-4 text-sm text-muted-foreground">
          No passkeys yet. Add one to skip the password screen on your next sign-in.
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-border rounded-md border border-border bg-card">
          {passkeys.map((p) => (
            <li key={p.id} className="flex items-center gap-3 p-3">
              <KeyIcon />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">
                  {p.nickname || 'Unnamed passkey'}
                </div>
                <div className="text-xs text-muted-foreground">
                  added {formatDate(p.createdAt)}
                  {p.lastUsedAt
                    ? ` · last used ${formatRelative(p.lastUsedAt)}`
                    : ' · not used yet'}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      <button
        type="button"
        onClick={() => void addPasskey()}
        disabled={enrolling}
        className="mt-4 inline-flex h-11 w-full items-center justify-center gap-2 rounded-md border border-border bg-card px-4 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-50"
      >
        <KeyIcon />
        {enrolling ? 'Waiting for authenticator…' : 'Add a passkey'}
      </button>

      {error && (
        <p
          role="alert"
          className="mt-3 rounded-md border border-destructive/30 bg-destructive/8 px-3 py-2 text-xs text-destructive"
        >
          {error}
        </p>
      )}

      <hr className="my-6 border-border" />

      <h2 className="text-base font-semibold">Sessions</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Sign out of every browser this account is signed into.
      </p>
      <button
        type="button"
        onClick={() => void signOut()}
        className="mt-4 inline-flex h-11 w-full items-center justify-center rounded-md border border-destructive/40 bg-transparent px-4 text-sm font-medium text-destructive transition-colors hover:bg-destructive/8"
      >
        Sign out
      </button>
    </div>
  );
}

function KeyIcon(): JSX.Element {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="shrink-0 text-accent"
    >
      <path d="m21 2-9.6 9.6" />
      <circle cx="7.5" cy="15.5" r="5.5" />
      <path d="m21 2-2 2" />
      <path d="m17 6 2 2" />
    </svg>
  );
}

function isUserCancel(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && (err as { name?: string }).name === 'NotAllowedError'
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (ms < minute) return 'just now';
  if (ms < hour) return `${Math.floor(ms / minute)}m ago`;
  if (ms < day) return `${Math.floor(ms / hour)}h ago`;
  return `${Math.floor(ms / day)}d ago`;
}
