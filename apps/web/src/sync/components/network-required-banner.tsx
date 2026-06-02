// Network-required banner (Milestone 1.10 S3, ADR-0009 §3.6).
//
// Surfaced inline next to a button whose action requires a live network
// (reveal endpoints, export endpoints, signed-bundle download, step-up).
// The S2 typed-client wrapper throws `NetworkRequiredError` whenever a
// require-online call hits a 503 with `error: network_required` or when
// `navigator.onLine === false`. Call sites catch the error, flip a local
// state flag, and render this banner.
//
// Copy is rights-protective + neutral: tells the rep WHAT they tried,
// WHY it cannot complete offline, and WHEN to retry. We do NOT shame
// the rep with "Your changes will be lost"-style framing; the queue-
// based mutations already drained; only reveal/export are gated.

import { AlertCircle, WifiOff } from 'lucide-react';

interface NetworkRequiredBannerProps {
  /** Short verb describing the attempted action, e.g. "Reveal",
   * "Export", "Download". Surface text is "<action> needs network." */
  readonly action?: string;
  /** Optional dismiss callback. When set, an "x" button renders so the
   * banner can be cleared after the rep has read it. */
  readonly onDismiss?: () => void;
  /** Optional extra classes (e.g. mt-3) for the wrapping element. */
  readonly className?: string;
}

/**
 * Inline banner — amber, AlertCircle icon, neutral copy. Pairs color
 * with icon + label per CLAUDE.md "never color alone".
 *
 * The banner is `role="status"` (not `role="alert"`) so screen readers
 * announce it politely — this is a recoverable advisory, not a blocking
 * error. The aria-live="polite" matches.
 */
export function NetworkRequiredBanner({
  action,
  onDismiss,
  className,
}: NetworkRequiredBannerProps): JSX.Element {
  const verb = action && action.length > 0 ? action : 'This action';
  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex items-start gap-2 rounded-md border border-status-pending/40 bg-status-pending/10 p-3 text-sm text-foreground ${
        className ?? ''
      }`}
    >
      <AlertCircle
        className="mt-0.5 h-4 w-4 shrink-0 text-status-pending"
        strokeWidth={2}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 font-medium">
          <WifiOff className="h-3.5 w-3.5 text-status-pending" strokeWidth={2} aria-hidden="true" />
          <span>{verb} needs network.</span>
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Try again when you&apos;re back online. Your queued changes will keep syncing in the
          background.
        </p>
      </div>
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="ml-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          Dismiss
        </button>
      ) : null}
    </div>
  );
}
