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

      <h2 className="text-base font-semibold">Authenticator (TOTP)</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Reset if you&rsquo;ve lost your authenticator or rotated devices. Requires a fresh passkey
        or current TOTP code.
      </p>
      <TotpResetPanel />

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

function TotpResetPanel(): JSX.Element {
  const [stage, setStage] = useState<'idle' | 'enrolling' | 'done'>('idle');
  const [secretB32, setSecretB32] = useState<string | null>(null);
  const [provisioning, setProvisioning] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.totp.resetStart();
      setSecretB32(r.totpSecretB32);
      setProvisioning(r.provisioning);
      setStage('enrolling');
    } catch (err) {
      if (err instanceof ApiError && err.kind === 'step_up_required') {
        // The step-up modal opened. User completes, then re-clicks Start.
        return;
      }
      setError('Could not start a reset.');
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (): Promise<void> => {
    if (busy || !provisioning) return;
    if (!/^[0-9]{6}$/.test(code)) {
      setError('Enter the 6-digit code from your new authenticator entry');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.totp.resetConfirm({ provisioning, totpCode: code });
      setStage('done');
      setSecretB32(null);
      setProvisioning(null);
      setCode('');
    } catch (err) {
      if (err instanceof ApiError && err.kind === 'totp_invalid') {
        setError('That code did not match. Try the next one your authenticator shows.');
      } else if (err instanceof ApiError && err.kind === 'provisioning_expired') {
        setError('The reset session expired. Start again.');
        setStage('idle');
      } else {
        setError('Could not confirm the reset.');
      }
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  if (stage === 'idle') {
    return (
      <div>
        <button
          type="button"
          onClick={() => void start()}
          disabled={busy}
          className="mt-4 inline-flex h-11 w-full items-center justify-center rounded-md border border-border bg-card px-4 text-sm font-medium hover:bg-muted disabled:opacity-50"
        >
          {busy ? 'Starting…' : 'Reset authenticator'}
        </button>
        {error && (
          <p
            role="alert"
            className="mt-3 rounded-md border border-destructive/30 bg-destructive/8 px-3 py-2 text-xs text-destructive"
          >
            {error}
          </p>
        )}
      </div>
    );
  }

  if (stage === 'enrolling') {
    return (
      <div className="mt-4 rounded-md border border-border bg-card p-4">
        <p className="text-sm font-medium">Add this entry to your authenticator app</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Manually enter the secret below (or scan the QR generated by your authenticator&rsquo;s
          OTP URI feature). Then enter the first 6-digit code it shows.
        </p>
        <div className="mt-3 rounded-md bg-muted px-3 py-2 text-center font-mono text-xs tracking-wider">
          {secretB32}
        </div>
        <label htmlFor="totp-reset-code" className="mt-4 mb-1.5 block text-sm font-medium">
          New authenticator code
        </label>
        <input
          id="totp-reset-code"
          inputMode="numeric"
          maxLength={6}
          autoComplete="one-time-code"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          className="h-11 w-full rounded-md border border-input bg-card text-center font-mono text-xl tracking-[0.4em] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          placeholder="••••••"
        />
        {error && (
          <p
            role="alert"
            className="mt-3 rounded-md border border-destructive/30 bg-destructive/8 px-3 py-2 text-xs text-destructive"
          >
            {error}
          </p>
        )}
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={() => {
              setStage('idle');
              setSecretB32(null);
              setProvisioning(null);
              setCode('');
              setError(null);
            }}
            className="inline-flex h-11 flex-1 items-center justify-center rounded-md border border-border bg-card px-4 text-sm font-medium hover:bg-muted"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void confirm()}
            disabled={busy}
            className="inline-flex h-11 flex-1 items-center justify-center rounded-md bg-accent px-4 text-sm font-medium text-accent-foreground hover:bg-accent/90 disabled:opacity-50"
          >
            {busy ? 'Confirming…' : 'Confirm reset'}
          </button>
        </div>
      </div>
    );
  }

  // 'done'
  return (
    <div className="mt-4 rounded-md border border-status-resolved/30 bg-status-resolved/8 p-3 text-xs leading-relaxed text-status-resolved">
      Authenticator reset.{' '}
      <button
        type="button"
        onClick={() => setStage('idle')}
        className="underline underline-offset-2 hover:text-status-resolved/80"
      >
        Reset again
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
