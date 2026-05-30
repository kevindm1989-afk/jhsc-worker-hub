// Login flows.
//
// Passkey-primary by default; "use password instead" routes to the
// password + TOTP form. Stage 2 of the password flow accepts a TOTP
// code; a "use a recovery code" toggle swaps to the recovery path.

import { startAuthentication } from '@simplewebauthn/browser';
import { useCallback, useId, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, api } from '../auth/api';
import { useAuth } from '../auth/auth-context';

type Mode = 'passkey' | 'password' | 'second-factor';
type SecondFactor = 'totp' | 'recovery';

export function LoginView(): JSX.Element {
  const [mode, setMode] = useState<Mode>('passkey');
  const [pending, setPending] = useState<string | null>(null);
  const { refresh } = useAuth();
  const navigate = useNavigate();

  const finishLogin = useCallback(async (): Promise<void> => {
    await refresh();
    navigate('/', { replace: true });
  }, [refresh, navigate]);

  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="mx-auto flex min-h-screen w-full max-w-[420px] flex-col gap-4 px-5 pb-12 pt-10 focus:outline-none"
    >
      {mode === 'passkey' && (
        <PasskeyPrimary onUsePassword={() => setMode('password')} onSignedIn={finishLogin} />
      )}
      {mode === 'password' && (
        <PasswordStage
          onPending={(p) => {
            setPending(p);
            setMode('second-factor');
          }}
          onUsePasskey={() => setMode('passkey')}
        />
      )}
      {mode === 'second-factor' && pending && (
        <SecondFactorStage
          pending={pending}
          onBack={() => setMode('password')}
          onSignedIn={finishLogin}
        />
      )}
    </main>
  );
}

// ---------------------------------------------------------------------------
// Passkey primary
// ---------------------------------------------------------------------------

interface PasskeyPrimaryProps {
  readonly onUsePassword: () => void;
  readonly onSignedIn: () => Promise<void>;
}

function PasskeyPrimary({ onUsePassword, onSignedIn }: PasskeyPrimaryProps): JSX.Element {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signIn = async (): Promise<void> => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const options = (await api.passkey.authOptions({})) as Parameters<
        typeof startAuthentication
      >[0]['optionsJSON'];
      const response = await startAuthentication({ optionsJSON: options });
      await api.passkey.authVerify(response);
      await onSignedIn();
    } catch (err) {
      // The browser throws DOMException 'NotAllowedError' when the user
      // cancels or no credential is available. We surface a generic
      // "try again or switch to password" message; nothing actionable in
      // showing the raw error.
      if (isUserCancel(err)) {
        setError(null);
      } else if (err instanceof ApiError) {
        setError('That passkey did not match. Try again, or use your password.');
      } else {
        setError('No passkey was available on this device.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Welcome back</h1>
      <p className="text-sm leading-relaxed text-muted-foreground">
        Use a passkey on this device — biometric or security key. The phishing-resistant path.
      </p>

      <button
        type="button"
        onClick={() => void signIn()}
        disabled={submitting}
        className="mt-2 inline-flex h-11 w-full items-center justify-center gap-2 rounded-md bg-accent px-4 text-sm font-medium text-accent-foreground transition-colors hover:bg-accent/90 disabled:opacity-50"
      >
        <KeyIcon />
        {submitting ? 'Waiting for passkey…' : 'Sign in with a passkey'}
      </button>

      {error && (
        <p
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/8 px-3 py-2 text-xs text-destructive"
        >
          {error}
        </p>
      )}

      <DividerWithText>or</DividerWithText>

      <button
        type="button"
        onClick={onUsePassword}
        className="inline-flex h-11 w-full items-center justify-center rounded-md border border-border bg-card px-4 text-sm font-medium text-foreground transition-colors hover:bg-muted"
      >
        Use password instead
      </button>

      <div className="mt-4 rounded-md border border-status-info/30 bg-status-info/8 p-3 text-xs leading-relaxed text-status-info">
        <strong>Why passkeys?</strong> They can&rsquo;t be phished. The browser checks the
        site&rsquo;s origin before unlocking the key — no fake page can trick it.
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Password stage 1
// ---------------------------------------------------------------------------

interface PasswordStageProps {
  readonly onPending: (pending: string) => void;
  readonly onUsePasskey: () => void;
}

function PasswordStage({ onPending, onUsePasskey }: PasswordStageProps): JSX.Element {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const emailId = useId();
  const pwId = useId();

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (submitting) return;
        setSubmitting(true);
        setError(null);
        try {
          const result = await api.passwordLogin.start({ email, password });
          onPending(result.pending);
        } catch (err) {
          setError(mapLoginError(err));
        } finally {
          setSubmitting(false);
        }
      }}
      noValidate
    >
      <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        Password + authenticator code. Both must be valid.
      </p>

      <div className="mt-6">
        <label htmlFor={emailId} className="mb-1.5 block text-sm font-medium">
          Email
        </label>
        <input
          id={emailId}
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="h-11 w-full rounded-md border border-input bg-card px-3 text-[15px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          required
        />
      </div>

      <div className="mt-4">
        <label htmlFor={pwId} className="mb-1.5 block text-sm font-medium">
          Password
        </label>
        <input
          id={pwId}
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="h-11 w-full rounded-md border border-input bg-card px-3 text-[15px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          required
        />
      </div>

      {error && (
        <p
          role="alert"
          className="mt-3 rounded-md border border-destructive/30 bg-destructive/8 px-3 py-2 text-xs text-destructive"
        >
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="mt-6 inline-flex h-11 w-full items-center justify-center rounded-md bg-accent px-4 text-sm font-medium text-accent-foreground transition-colors hover:bg-accent/90 disabled:opacity-50"
      >
        {submitting ? 'Checking…' : 'Continue'}
      </button>

      <button
        type="button"
        onClick={onUsePasskey}
        className="mt-2 inline-flex h-10 w-full items-center justify-center rounded-md text-sm font-medium text-accent hover:bg-accent/8"
      >
        ← Use a passkey instead
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Second factor (TOTP or recovery)
// ---------------------------------------------------------------------------

interface SecondFactorStageProps {
  readonly pending: string;
  readonly onBack: () => void;
  readonly onSignedIn: () => Promise<void>;
}

function SecondFactorStage({ pending, onBack, onSignedIn }: SecondFactorStageProps): JSX.Element {
  const [factor, setFactor] = useState<SecondFactor>('totp');
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const totpId = useId();
  const recoveryId = useId();

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (submitting) return;
        setSubmitting(true);
        setError(null);
        try {
          if (factor === 'totp') {
            if (!/^[0-9]{6}$/.test(code)) throw new ApiError(400, { error: 'totp_invalid' });
            await api.passwordLogin.totp({ pending, totpCode: code });
          } else {
            await api.passwordLogin.recovery({ pending, recoveryCode: recovery });
          }
          await onSignedIn();
        } catch (err) {
          setError(mapLoginError(err));
        } finally {
          setSubmitting(false);
        }
      }}
      noValidate
    >
      <h1 className="text-2xl font-semibold tracking-tight">Enter your code</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        {factor === 'totp'
          ? 'The 6-digit code from your authenticator. Codes expire every 30 seconds.'
          : 'Recovery codes are one-time use. Each works exactly once.'}
      </p>

      {factor === 'totp' ? (
        <div className="mt-6">
          <label htmlFor={totpId} className="mb-1.5 block text-sm font-medium">
            Authenticator code
          </label>
          <input
            id={totpId}
            inputMode="numeric"
            maxLength={6}
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            className="h-11 w-full rounded-md border border-input bg-card text-center font-mono text-xl tracking-[0.4em] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            placeholder="••••••"
          />
        </div>
      ) : (
        <div className="mt-6">
          <label htmlFor={recoveryId} className="mb-1.5 block text-sm font-medium">
            Recovery code
          </label>
          <input
            id={recoveryId}
            type="text"
            autoComplete="off"
            value={recovery}
            onChange={(e) => setRecovery(e.target.value)}
            className="h-11 w-full rounded-md border border-input bg-card px-3 font-mono text-base tracking-widest focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            placeholder="ABCDE-FGHJK"
          />
        </div>
      )}

      {error && (
        <p
          role="alert"
          className="mt-3 rounded-md border border-destructive/30 bg-destructive/8 px-3 py-2 text-xs text-destructive"
        >
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="mt-6 inline-flex h-11 w-full items-center justify-center rounded-md bg-accent px-4 text-sm font-medium text-accent-foreground transition-colors hover:bg-accent/90 disabled:opacity-50"
      >
        {submitting ? 'Signing in…' : 'Sign in'}
      </button>

      <button
        type="button"
        onClick={() => {
          setFactor(factor === 'totp' ? 'recovery' : 'totp');
          setError(null);
        }}
        className="mt-3 inline-flex h-10 w-full items-center justify-center rounded-md border border-border bg-card text-sm font-medium hover:bg-muted"
      >
        {factor === 'totp' ? 'Use a recovery code' : 'Use authenticator code'}
      </button>

      <button
        type="button"
        onClick={onBack}
        className="mt-2 inline-flex h-10 w-full items-center justify-center rounded-md text-sm font-medium text-accent hover:bg-accent/8"
      >
        ← Back
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Bits
// ---------------------------------------------------------------------------

function DividerWithText({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="my-4 flex items-center gap-3">
      <div className="h-px flex-1 bg-border" />
      <span className="text-xs uppercase tracking-wider text-muted-foreground">{children}</span>
      <div className="h-px flex-1 bg-border" />
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

function mapLoginError(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.kind) {
      case 'invalid_credentials':
        return 'Email or password is incorrect.';
      case 'totp_invalid':
        return 'That code did not match. Try the next one your authenticator shows.';
      case 'recovery_code_invalid':
        return 'That recovery code is not valid (or already used).';
      case 'lockout_short':
      case 'lockout_long':
        return 'Too many failed attempts. Try again in a few minutes.';
      case 'lockout_hard':
        return 'Sign-in is locked. Contact your administrator to unlock.';
      default:
        return 'Could not sign in. Try again.';
    }
  }
  return 'Could not sign in. Try again.';
}
