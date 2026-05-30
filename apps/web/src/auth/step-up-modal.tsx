// Global step-up modal (1.3 — closes the deferred Slice 6 1.2 item).
//
// Listens to stepUpEmitter; whenever an API call hits a 401-StepUp,
// the modal opens with the action name. The user runs a passkey
// assertion or types a TOTP; on success the modal closes and the
// caller can retry the original request.
//
// The caller-retry pattern is intentional. We do NOT auto-retry the
// originating request here because the modal does not know what it
// was. The pattern in calling code:
//
//   try {
//     await api.passkey.remove(id);
//   } catch (e) {
//     if (e instanceof ApiError && e.kind === 'step_up_required') {
//       // The modal opened. Wait for it to resolve, then retry.
//       await stepUpEmitter.waitForResolution();
//       await api.passkey.remove(id);
//     }
//   }
//
// stepUpEmitter exposes a waitForResolution() promise that resolves
// when the modal closes after a successful step-up.

import { startAuthentication } from '@simplewebauthn/browser';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ApiError, api, stepUpEmitter } from './api';

type Mode = 'choice' | 'totp';

export function StepUpModal(): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [action, setAction] = useState<string>('');
  const [mode, setMode] = useState<Mode>('choice');
  const [totpCode, setTotpCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const totpInputId = useId();
  const resolveRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const unsub = stepUpEmitter.subscribe((act) => {
      setAction(act);
      setMode('choice');
      setError(null);
      setTotpCode('');
      setOpen(true);
    });
    return unsub;
  }, []);

  const close = useCallback((resolved: boolean): void => {
    setOpen(false);
    if (resolved && resolveRef.current) {
      resolveRef.current();
      resolveRef.current = null;
    }
  }, []);

  const onPasskey = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const options = (await api.stepUp.passkeyOptions()) as Parameters<
        typeof startAuthentication
      >[0]['optionsJSON'];
      const response = await startAuthentication({ optionsJSON: options });
      await api.stepUp.passkeyVerify(response);
      close(true);
    } catch (err) {
      if (isUserCancel(err)) {
        setError(null);
      } else if (err instanceof ApiError) {
        setError('Step-up failed. Try again, or use your authenticator.');
      } else {
        setError('No passkey was available.');
      }
    } finally {
      setBusy(false);
    }
  };

  const onTotp = async (): Promise<void> => {
    if (busy) return;
    if (!/^[0-9]{6}$/.test(totpCode)) {
      setError('Enter the 6-digit code from your authenticator');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.stepUp.totp({ totpCode });
      close(true);
    } catch (err) {
      if (err instanceof ApiError) {
        setError('That code did not match. Try the next one your authenticator shows.');
      } else {
        setError('Could not verify the code.');
      }
      setTotpCode('');
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="step-up-title"
      className="fixed inset-0 z-50 flex items-end bg-foreground/50 backdrop-blur-sm"
      onClick={() => close(false)}
    >
      <div
        className="w-full rounded-t-2xl bg-card p-6 pb-8 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mb-4 h-1 w-8 rounded-full bg-border" aria-hidden />
        <h2 id="step-up-title" className="mb-1 text-base font-semibold">
          Confirm it&rsquo;s you
        </h2>
        <p className="mb-4 text-sm leading-relaxed text-muted-foreground">
          You&rsquo;re about to <strong>{actionCopy(action)}</strong>. We need a fresh
          authentication before continuing.
        </p>

        {mode === 'choice' && (
          <>
            <button
              type="button"
              onClick={() => void onPasskey()}
              disabled={busy}
              className="inline-flex h-11 w-full items-center justify-center rounded-md bg-accent px-4 text-sm font-medium text-accent-foreground transition-colors hover:bg-accent/90 disabled:opacity-50"
            >
              {busy ? 'Waiting for passkey…' : 'Use a passkey'}
            </button>
            <div className="my-3 flex items-center gap-3">
              <div className="h-px flex-1 bg-border" />
              <span className="text-xs uppercase tracking-wider text-muted-foreground">or</span>
              <div className="h-px flex-1 bg-border" />
            </div>
            <button
              type="button"
              onClick={() => setMode('totp')}
              className="inline-flex h-11 w-full items-center justify-center rounded-md border border-border bg-card px-4 text-sm font-medium hover:bg-muted"
            >
              Use authenticator code
            </button>
          </>
        )}

        {mode === 'totp' && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void onTotp();
            }}
          >
            <label htmlFor={totpInputId} className="mb-1.5 block text-sm font-medium">
              Authenticator code
            </label>
            <input
              id={totpInputId}
              inputMode="numeric"
              maxLength={6}
              autoComplete="one-time-code"
              autoFocus
              value={totpCode}
              onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ''))}
              className="h-11 w-full rounded-md border border-input bg-card text-center font-mono text-xl tracking-[0.4em] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              placeholder="••••••"
            />
            <p className="mt-1.5 text-xs text-muted-foreground">
              The 6-digit code from your authenticator app.
            </p>
            <button
              type="submit"
              disabled={busy}
              className="mt-4 inline-flex h-11 w-full items-center justify-center rounded-md bg-accent px-4 text-sm font-medium text-accent-foreground hover:bg-accent/90 disabled:opacity-50"
            >
              {busy ? 'Verifying…' : 'Confirm'}
            </button>
          </form>
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
          type="button"
          onClick={() => close(false)}
          className="mt-4 inline-flex h-9 w-full items-center justify-center rounded-md text-xs font-medium text-muted-foreground hover:bg-muted"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function actionCopy(action: string): string {
  switch (action) {
    case 'passkey.remove':
      return 'remove a passkey';
    case 'totp.reset':
      return 'reset your authenticator';
    case 'export.generate':
      return 'generate an export';
    default:
      return 'perform a sensitive action';
  }
}

function isUserCancel(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && (err as { name?: string }).name === 'NotAllowedError'
  );
}
