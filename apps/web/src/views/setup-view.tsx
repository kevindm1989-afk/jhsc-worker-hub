// First-run setup wizard (ADR-0001 + Slice 6 preview).
//
// Step 1 (account)  — email / display name / password  → /first-run/setup
// Step 2 (TOTP)     — render the otpauth:// URI as a QR + plaintext;
//                     verify the first code            → /first-run/confirm
// Step 3 (done)     — banner explaining "next: add a passkey" + push to /

import { useCallback, useEffect, useId, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, api } from '../auth/api';
import { useAuth } from '../auth/auth-context';
import { qrToSvg } from '../auth/qr';

type Stage = 'account' | 'totp' | 'done';

interface AccountValues {
  readonly email: string;
  readonly displayName: string;
  readonly password: string;
}

interface ProvisioningCarryover {
  readonly provisioning: string;
  readonly totpUri: string;
  readonly totpSecretB32: string;
}

export function SetupView(): JSX.Element {
  const [stage, setStage] = useState<Stage>('account');
  const [account, setAccount] = useState<AccountValues>({
    email: '',
    displayName: '',
    password: '',
  });
  const [provisioning, setProvisioning] = useState<ProvisioningCarryover | null>(null);
  const { refresh } = useAuth();
  const navigate = useNavigate();

  const onAccountSubmit = useCallback(async (values: AccountValues): Promise<void> => {
    setAccount(values);
    const result = await api.firstRun.setup(values);
    setProvisioning(result);
    setStage('totp');
  }, []);

  const onTotpConfirm = useCallback(
    async (code: string): Promise<void> => {
      if (!provisioning) throw new Error('setup state lost');
      await api.firstRun.confirm({ provisioning: provisioning.provisioning, totpCode: code });
      setStage('done');
    },
    [provisioning],
  );

  const onFinish = useCallback(async (): Promise<void> => {
    await refresh();
    navigate('/', { replace: true });
  }, [refresh, navigate]);

  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="mx-auto flex min-h-screen w-full max-w-[420px] flex-col gap-6 px-5 pb-12 pt-8 focus:outline-none"
    >
      <Stepper stage={stage} />
      {stage === 'account' && <AccountForm initial={account} onSubmit={onAccountSubmit} />}
      {stage === 'totp' && provisioning && (
        <TotpForm
          uri={provisioning.totpUri}
          secret={provisioning.totpSecretB32}
          email={account.email}
          onSubmit={onTotpConfirm}
          onBack={() => setStage('account')}
        />
      )}
      {stage === 'done' && <DoneScreen onFinish={onFinish} />}
    </main>
  );
}

function Stepper({ stage }: { stage: Stage }): JSX.Element {
  const dots: Array<'done' | 'active' | 'pending'> =
    stage === 'account'
      ? ['active', 'pending', 'pending']
      : stage === 'totp'
        ? ['done', 'active', 'pending']
        : ['done', 'done', 'active'];
  return (
    <div className="flex gap-1.5" aria-hidden>
      {dots.map((d, i) => (
        <div
          key={i}
          className={`h-1 flex-1 rounded-full ${
            d === 'active' ? 'bg-accent' : d === 'done' ? 'bg-accent/50' : 'bg-border'
          }`}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 1 — account
// ---------------------------------------------------------------------------

interface AccountFormProps {
  readonly initial: AccountValues;
  readonly onSubmit: (values: AccountValues) => Promise<void>;
}

function AccountForm({ initial, onSubmit }: AccountFormProps): JSX.Element {
  const [email, setEmail] = useState(initial.email);
  const [displayName, setDisplayName] = useState(initial.displayName);
  const [password, setPassword] = useState(initial.password);
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<ReadonlyArray<string>>([]);
  const emailId = useId();
  const nameId = useId();
  const pwId = useId();

  const issues = clientValidate({ email, displayName, password });

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (submitting) return;
        if (issues.length > 0) {
          setErrors(issues);
          return;
        }
        setSubmitting(true);
        setErrors([]);
        try {
          await onSubmit({ email, displayName, password });
        } catch (err) {
          setErrors(toMessages(err));
        } finally {
          setSubmitting(false);
        }
      }}
      noValidate
    >
      <h1 className="text-2xl font-semibold tracking-tight">Set up your account</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        One co-chair account per workplace. After this you&rsquo;ll add a second factor and at least
        one passkey.
      </p>

      <div className="mt-6">
        <label htmlFor={emailId} className="mb-1.5 block text-sm font-medium">
          Work email
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
        <p className="mt-1.5 text-xs text-muted-foreground">
          Used to sign in. Stored encrypted at rest.
        </p>
      </div>

      <div className="mt-4">
        <label htmlFor={nameId} className="mb-1.5 block text-sm font-medium">
          Display name
        </label>
        <input
          id={nameId}
          type="text"
          autoComplete="name"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
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
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="h-11 w-full rounded-md border border-input bg-card px-3 text-[15px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          required
        />
        <p className="mt-1.5 text-xs text-muted-foreground">
          Minimum 12 characters. Must include upper, lower, digit, symbol.
        </p>
      </div>

      <ErrorList errors={errors} />

      <button
        type="submit"
        disabled={submitting}
        className="mt-6 inline-flex h-11 w-full items-center justify-center rounded-md bg-accent px-4 text-sm font-medium text-accent-foreground transition-colors hover:bg-accent/90 disabled:opacity-50"
      >
        {submitting ? 'Setting up…' : 'Continue → set up second factor'}
      </button>
    </form>
  );
}

function clientValidate(v: AccountValues): ReadonlyArray<string> {
  const issues: string[] = [];
  if (!/.+@.+\..+/.test(v.email)) issues.push('Enter a valid email address');
  if (v.displayName.trim().length === 0) issues.push('Display name is required');
  if (v.password.length < 12) issues.push('Password must be at least 12 characters');
  if (!/[a-z]/.test(v.password)) issues.push('Password must contain a lowercase letter');
  if (!/[A-Z]/.test(v.password)) issues.push('Password must contain an uppercase letter');
  if (!/[0-9]/.test(v.password)) issues.push('Password must contain a digit');
  if (!/[^A-Za-z0-9]/.test(v.password)) issues.push('Password must contain a symbol');
  return issues;
}

// ---------------------------------------------------------------------------
// Step 2 — TOTP
// ---------------------------------------------------------------------------

interface TotpFormProps {
  readonly uri: string;
  readonly secret: string;
  readonly email: string;
  readonly onSubmit: (code: string) => Promise<void>;
  readonly onBack: () => void;
}

function TotpForm({ uri, secret, email, onSubmit, onBack }: TotpFormProps): JSX.Element {
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<ReadonlyArray<string>>([]);
  const [qr, setQr] = useState<string | null>(null);
  const totpId = useId();

  useEffect(() => {
    void qrToSvg(uri)
      .then(setQr)
      .catch(() => setQr(null));
  }, [uri]);

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (submitting) return;
        if (!/^[0-9]{6}$/.test(code)) {
          setErrors(['Enter the 6-digit code from your authenticator']);
          return;
        }
        setSubmitting(true);
        setErrors([]);
        try {
          await onSubmit(code);
        } catch (err) {
          setErrors(toMessages(err));
          setCode('');
        } finally {
          setSubmitting(false);
        }
      }}
      noValidate
    >
      <h1 className="text-2xl font-semibold tracking-tight">Scan with an authenticator app</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        Use any authenticator (1Password, Authy, Aegis, etc.). We never email codes. The QR encodes
        a TOTP secret that never leaves this device unencrypted.
      </p>

      <div className="mx-auto mt-5 flex h-[208px] w-[208px] items-center justify-center rounded-lg border border-border bg-white p-2">
        {qr ? (
          <div className="h-full w-full" dangerouslySetInnerHTML={{ __html: qr }} />
        ) : (
          <div className="h-full w-full animate-pulse rounded bg-muted" />
        )}
      </div>

      <p className="mt-2 text-center text-xs text-muted-foreground">
        Account: <span className="font-mono">{email}</span>
      </p>

      <div className="mt-4">
        <p className="mb-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Or enter the secret manually
        </p>
        <div className="rounded-md bg-muted px-3 py-2 text-center font-mono text-xs tracking-wider">
          {secret}
        </div>
      </div>

      <div className="mt-6">
        <label htmlFor={totpId} className="mb-1.5 block text-sm font-medium">
          Enter the first 6-digit code
        </label>
        <input
          id={totpId}
          inputMode="numeric"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          className="h-11 w-full rounded-md border border-input bg-card text-center font-mono text-xl tracking-[0.4em] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          placeholder="••••••"
          autoComplete="one-time-code"
        />
      </div>

      <ErrorList errors={errors} />

      <button
        type="submit"
        disabled={submitting}
        className="mt-6 inline-flex h-11 w-full items-center justify-center rounded-md bg-accent px-4 text-sm font-medium text-accent-foreground transition-colors hover:bg-accent/90 disabled:opacity-50"
      >
        {submitting ? 'Verifying…' : 'Verify and continue'}
      </button>
      <button
        type="button"
        onClick={onBack}
        className="mt-2 inline-flex h-10 w-full items-center justify-center rounded-md text-sm font-medium text-accent hover:bg-accent/8"
      >
        Back
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Step 3 — done
// ---------------------------------------------------------------------------

function DoneScreen({ onFinish }: { onFinish: () => Promise<void> }): JSX.Element {
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">You&rsquo;re in</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        Your account is set up with a password and an authenticator. Next, add a passkey from
        Account → Security so you can sign in without typing your password.
      </p>

      <div className="mt-6 rounded-md border border-status-pending/30 bg-status-pending/8 p-3 text-xs leading-relaxed">
        <strong>Recovery codes are not yet available.</strong> The generation endpoint lands in
        Release 1 alongside Account → Security polish. Until then, keep your authenticator backed up
        (1Password / Authy / Aegis sync). If you lose it, an administrator can reset access via the
        documented runbook.
      </div>

      <button
        type="button"
        onClick={() => void onFinish()}
        className="mt-6 inline-flex h-11 w-full items-center justify-center rounded-md bg-accent px-4 text-sm font-medium text-accent-foreground transition-colors hover:bg-accent/90"
      >
        Enter the app
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

function ErrorList({ errors }: { errors: ReadonlyArray<string> }): JSX.Element | null {
  if (errors.length === 0) return null;
  return (
    <ul
      role="alert"
      className="mt-4 list-disc space-y-1 rounded-md border border-destructive/30 bg-destructive/8 pl-9 pr-3 py-2 text-xs leading-relaxed text-destructive"
    >
      {errors.map((e) => (
        <li key={e}>{e}</li>
      ))}
    </ul>
  );
}

function toMessages(err: unknown): ReadonlyArray<string> {
  if (err instanceof ApiError) {
    if (err.status === 400 && Array.isArray((err.payload as { issues?: unknown }).issues)) {
      return ((err.payload as { issues: unknown[] }).issues as string[]).filter(
        (s): s is string => typeof s === 'string',
      );
    }
    return [mapKind(err.kind ?? `${err.status}`)];
  }
  return ['Something went wrong. Please try again.'];
}

function mapKind(kind: string): string {
  switch (kind) {
    case 'totp_invalid':
      return 'That code did not match. Try the next one your authenticator shows.';
    case 'invalid_provisioning':
      return 'The setup session is invalid. Start again.';
    case 'provisioning_expired':
      return 'The setup session expired. Start again.';
    case 'not_found':
      return 'Setup has already been completed for this workplace.';
    default:
      return `Could not complete setup (${kind}).`;
  }
}
