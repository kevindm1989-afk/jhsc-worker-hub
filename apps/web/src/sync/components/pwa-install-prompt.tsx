// PWA install prompt (Milestone 1.10 S3, ADR-0009 §3.10, SECURITY.md
// §2.10 T-S37).
//
// Two distinct flows, no overlap:
//
//   - Android Chrome (and other Chromium-derived browsers): listen for
//     the `beforeinstallprompt` event. The browser dispatches it when
//     PWA-install criteria are met (manifest + service worker +
//     engagement heuristic). We cache the event handle and surface a
//     small banner. Tapping "Install" calls `event.prompt()` — the
//     browser draws the native confirmation; we cannot spoof it
//     (T-S37: install prompt phishing).
//
//   - iOS Safari: no programmatic install. We render a modal with the
//     manual "Add to Home Screen" path via the Share sheet. iOS 17+
//     supports installable PWAs with manifest; the user does the
//     navigation, we just describe it.
//
// Trigger gating (ADR §3.10): we wait until the rep has shown a sign of
// engagement before nagging:
//
//   - Session count >= 3   (localStorage.jhsc.sessionCount, bumped per
//                           AuthProvider mount)
//   - OR evidence captured >= 1 (Dexie evidence_files row exists)
//
//   AND NOT already installed  (display-mode standalone)
//   AND NOT previously dismissed (localStorage.jhsc.pwaInstallDismissed)
//
// Modes:
//   - `auto`: self-mount; render the banner only when gating passes.
//   - `inline`: render inside the sync panel even before gating passes,
//     so the rep can find the install affordance on demand.

import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Download, Share, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { db } from '../db';

const SESSION_COUNT_KEY = 'jhsc.sessionCount';
const DISMISSED_KEY = 'jhsc.pwaInstallDismissed';
const SESSION_MIN = 3;

/** Shape of the `beforeinstallprompt` event the dialog stores. We type
 * it minimally because the DOM lib types call it `Event` and `prompt()`
 * is a Chromium extension. */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/** Detect platform — Android Chrome vs iOS Safari vs other. */
function detectPlatform(): 'android' | 'ios' | 'other' {
  if (typeof navigator === 'undefined') return 'other';
  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return 'other';
}

/** Check if the app is already installed. */
function isInstalled(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(display-mode: standalone)').matches;
  } catch {
    return false;
  }
}

/** Read the current session count from localStorage. Returns 0 if
 * missing or malformed. */
function readSessionCount(): number {
  if (typeof window === 'undefined') return 0;
  try {
    const raw = window.localStorage.getItem(SESSION_COUNT_KEY);
    const n = raw === null ? 0 : Number.parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** Bump the session counter. Exported so the auth-bootstrap path can
 * call it once per fresh session (post-login). */
export function bumpSessionCount(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SESSION_COUNT_KEY, String(readSessionCount() + 1));
  } catch {
    // localStorage can throw in private-mode Safari etc.; ignore.
  }
}

interface PwaInstallPromptProps {
  /** `auto` = self-mount as a fixed banner when gating passes; `inline`
   * = embeddable surface for the sync panel that always renders the
   * affordance (rep-initiated install). */
  readonly mode?: 'auto' | 'inline';
}

export function PwaInstallPrompt({ mode = 'auto' }: PwaInstallPromptProps): JSX.Element | null {
  const platform = useMemo(() => detectPlatform(), []);
  const installed = useMemo(() => isInstalled(), []);
  const [dismissed, setDismissed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try {
      return window.localStorage.getItem(DISMISSED_KEY) === 'true';
    } catch {
      return false;
    }
  });
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [evidenceCount, setEvidenceCount] = useState<number>(0);
  const [iosModalOpen, setIosModalOpen] = useState(false);

  // Capture the beforeinstallprompt event so we can fire it later.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = (e: Event): void => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  // Read the evidence count once on mount. We don't subscribe to Dexie
  // changes here — the gating heuristic is "have they captured anything
  // yet?", not a live count.
  useEffect(() => {
    let cancelled = false;
    db.evidence_files
      .count()
      .then((c) => {
        if (!cancelled) setEvidenceCount(c);
      })
      .catch(() => {
        if (!cancelled) setEvidenceCount(0);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const sessionCount = readSessionCount();
  const gatingPassed = sessionCount >= SESSION_MIN || evidenceCount >= 1;

  const onSoftDismiss = (): void => {
    setDeferredPrompt(null);
    setIosModalOpen(false);
  };
  const onHardDismiss = (): void => {
    setDismissed(true);
    setDeferredPrompt(null);
    setIosModalOpen(false);
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(DISMISSED_KEY, 'true');
      } catch {
        // ignore
      }
    }
  };

  const onAndroidInstall = (): void => {
    const evt = deferredPrompt;
    if (!evt) return;
    void evt.prompt();
    void evt.userChoice.then(() => {
      // Either outcome clears the cached event; the browser only fires
      // beforeinstallprompt once per session.
      setDeferredPrompt(null);
    });
  };

  // Render decision tree.
  if (installed) return null;
  if (mode === 'auto' && dismissed) return null;
  if (mode === 'auto' && !gatingPassed) return null;
  if (platform === 'other' && !deferredPrompt && mode === 'auto') return null;

  if (mode === 'inline') {
    // Inline always renders a small affordance so the rep can opt in
    // even before gating fires. Skip if dismissed in inline mode too,
    // BUT show a small "Don't ask again — undo" wouldn't be valuable;
    // we just hide.
    if (dismissed) return null;
  }

  const installable = platform === 'android' && deferredPrompt !== null;

  return (
    <>
      <section
        aria-labelledby="pwa-install-heading"
        className={`mt-3 rounded-md border border-primary/30 bg-primary/5 p-3 text-xs ${
          mode === 'auto'
            ? 'fixed bottom-20 left-3 right-3 z-30 md:left-auto md:right-6 md:max-w-sm'
            : ''
        }`}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-start gap-2">
            <Download
              className="mt-0.5 h-4 w-4 shrink-0 text-primary"
              strokeWidth={2}
              aria-hidden="true"
            />
            <div>
              <h3 id="pwa-install-heading" className="text-sm font-medium text-foreground">
                Install JHSC Worker Hub
              </h3>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Add to your home screen for offline access and faster launches.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onSoftDismiss}
            aria-label="Close install prompt"
            className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <X className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {installable ? (
            <Button type="button" size="sm" onClick={onAndroidInstall}>
              <Download className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
              Install
            </Button>
          ) : platform === 'ios' ? (
            <Button type="button" size="sm" onClick={() => setIosModalOpen(true)}>
              <Share className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
              How to install on iOS
            </Button>
          ) : (
            <span className="text-[11px] text-muted-foreground">
              Install isn&apos;t available in this browser yet. Visit on Chrome or Safari.
            </span>
          )}
          <Button type="button" size="sm" variant="ghost" onClick={onSoftDismiss}>
            Maybe later
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={onHardDismiss}>
            Don&apos;t ask again
          </Button>
        </div>
      </section>
      {iosModalOpen ? <IosInstructions onClose={onSoftDismiss} /> : null}
    </>
  );
}

function IosInstructions({ onClose }: { onClose: () => void }): JSX.Element {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="ios-install-title"
      className="fixed inset-0 z-50 flex items-end justify-center bg-foreground/50 backdrop-blur-sm md:items-center"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-t-2xl bg-card p-5 pb-7 shadow-lg md:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-2">
          <h2
            id="ios-install-title"
            className="text-base font-semibold tracking-tight text-foreground"
          >
            Install on iOS
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <X className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
        <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm text-foreground">
          <li>
            Tap the <Share className="inline h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />{' '}
            <strong>Share</strong> button in Safari&apos;s toolbar.
          </li>
          <li>
            Scroll down and tap <strong>Add to Home Screen</strong>.
          </li>
          <li>
            Confirm the name and tap <strong>Add</strong>. The app appears on your home screen.
          </li>
        </ol>
        <p className="mt-3 flex items-start gap-1.5 rounded-md border border-border bg-background p-2 text-[11px] text-muted-foreground">
          <CheckCircle2
            className="mt-0.5 h-3 w-3 shrink-0 text-status-resolved"
            strokeWidth={2}
            aria-hidden="true"
          />
          Once installed, the app launches full-screen with offline support.
        </p>
        <div className="mt-4 flex justify-end">
          <Button type="button" onClick={onClose}>
            Got it
          </Button>
        </div>
      </div>
    </div>
  );
}

// Exported for tests.
export const _internal = {
  detectPlatform,
  isInstalled,
  readSessionCount,
  SESSION_COUNT_KEY,
  DISMISSED_KEY,
  SESSION_MIN,
};
