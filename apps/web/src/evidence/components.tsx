// Evidence primitives: FAB (Capture-to-Record entry point), evidence
// card list, and the VoiceToText input enhancement.

import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Camera, FileText, Lock, Mic, MicOff } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { evidenceApi, EvidenceApiError, type EvidenceItem } from '@/evidence/api';
import type { EvidenceLinkedType } from '@jhsc/shared-types';
import { stepUpEmitter } from '@/auth/api';

// ---------------------------------------------------------------------------
// <CaptureFab /> — fixed bottom-right entry point on mobile.
// ---------------------------------------------------------------------------

export function CaptureFab({
  linkedType,
  linkedId,
}: {
  linkedType: EvidenceLinkedType;
  linkedId: string;
}): JSX.Element {
  const href = `/capture?linkedType=${encodeURIComponent(linkedType)}&linkedId=${encodeURIComponent(linkedId)}`;
  return (
    <Link
      to={href}
      aria-label="Capture evidence"
      data-print="hide"
      className="fixed bottom-20 right-4 z-30 flex h-14 w-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg ring-1 ring-black/5 focus:outline-none focus:ring-2 focus:ring-ring md:bottom-6"
    >
      <Camera className="h-6 w-6" strokeWidth={2} aria-hidden="true" />
    </Link>
  );
}

// ---------------------------------------------------------------------------
// <EvidenceList /> — renders the evidence rows for an owning entity.
// Decrypt-on-tap (step-up gated) opens the plaintext in a new tab.
// ---------------------------------------------------------------------------

export function EvidenceList({
  linkedType,
  linkedId,
}: {
  linkedType: EvidenceLinkedType;
  linkedId: string;
}): JSX.Element {
  return (
    <EvidenceListInner
      key={`${linkedType}::${linkedId}`}
      linkedType={linkedType}
      linkedId={linkedId}
    />
  );
}

function EvidenceListInner({
  linkedType,
  linkedId,
}: {
  linkedType: EvidenceLinkedType;
  linkedId: string;
}): JSX.Element {
  const [items, setItems] = useState<ReadonlyArray<EvidenceItem> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    evidenceApi
      .list(linkedType, linkedId)
      .then((r) => {
        if (!cancelled) setItems(r.items);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [linkedType, linkedId]);

  async function onReveal(item: EvidenceItem): Promise<void> {
    try {
      const res = await fetch(evidenceApi.decryptUrl(item.id), {
        credentials: 'same-origin',
        headers: { 'X-Requested-With': 'jhsc-web' },
      });
      if (res.status === 401) {
        const body = (await res.json().catch(() => null)) as { action?: string } | null;
        stepUpEmitter.dispatch(body?.action ?? 'evidence.read');
        return;
      }
      if (!res.ok) throw new EvidenceApiError(res.status, await res.text().catch(() => ''));
      const blob = await res.blob();
      // Open in a new tab via a transient object URL. sec-F10 close-
      // out: 5s revoke (was 30s). The browser loads a blob URL
      // synchronously; 30s left the plaintext alive in process memory
      // for half a minute past the moment the new tab finished
      // loading. The decrypt response is Content-Disposition: attachment
      // (sec-F6) so the user gets a download dialog -- the URL only
      // needs to survive the dispatch.
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener,noreferrer');
      setTimeout(() => URL.revokeObjectURL(url), 5_000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  if (error) {
    return (
      <div className="rounded-md border border-status-rejected/40 bg-status-rejected/10 p-3 text-sm text-status-rejected">
        {error}
      </div>
    );
  }
  if (!items) return <div className="text-sm text-muted-foreground">Loading evidence…</div>;
  if (items.length === 0) {
    return (
      <div className="text-sm text-muted-foreground">
        No evidence attached. Tap the camera button to capture a photo.
      </div>
    );
  }
  return (
    <ul className="space-y-2">
      {items.map((it) => (
        <li key={it.id}>
          <EvidenceCard item={it} onReveal={() => onReveal(it)} />
        </li>
      ))}
    </ul>
  );
}

function EvidenceCard({
  item,
  onReveal,
}: {
  item: EvidenceItem;
  onReveal: () => void;
}): JSX.Element {
  const icon = item.mimeType.startsWith('image/')
    ? Camera
    : item.mimeType.startsWith('audio/')
      ? Mic
      : FileText;
  const Icon = icon;
  const sizeKb = Math.round(item.byteSize / 1024);
  return (
    <div className="flex items-center gap-3 rounded-md border border-border bg-card p-3">
      <Icon
        className="h-5 w-5 shrink-0 text-muted-foreground"
        strokeWidth={1.75}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Lock className="h-3 w-3 text-muted-foreground" strokeWidth={1.75} aria-hidden="true" />
          <span className="text-xs uppercase tracking-wide text-muted-foreground">
            Encrypted · {sizeKb} KB · {item.mimeType}
          </span>
        </div>
        <div className="mt-0.5 font-mono text-[11px] tabular-nums text-muted-foreground">
          {item.plaintextSha256.slice(0, 12)}…
        </div>
        {item.gpsLatitude !== null && item.gpsLongitude !== null ? (
          <div className="text-[11px] text-muted-foreground">
            {item.gpsLatitude.toFixed(4)}, {item.gpsLongitude.toFixed(4)}
            {item.gpsAccuracyM !== null ? ` (±${Math.round(item.gpsAccuracyM)}m)` : ''}
          </div>
        ) : null}
      </div>
      <Button type="button" variant="outline" size="sm" onClick={onReveal}>
        Reveal
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// <VoiceToText /> — wraps native SpeechRecognition (CLAUDE.md #3:
// no third-party ASR). Falls back to plain textarea when the browser
// doesn't ship the API (Firefox + Safari desktop).
// ---------------------------------------------------------------------------

interface SpeechRecognitionLike extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  onresult: ((ev: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onend: (() => void) | null;
}

function getSpeechRecognition(): { new (): SpeechRecognitionLike } | null {
  if (typeof window === 'undefined') return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function VoiceToText({
  value,
  onChange,
  rows = 6,
  placeholder,
  className,
}: {
  value: string;
  onChange: (next: string) => void;
  rows?: number;
  placeholder?: string;
  className?: string;
}): JSX.Element {
  const [listening, setListening] = useState(false);
  const recogRef = useRef<SpeechRecognitionLike | null>(null);
  const supported = getSpeechRecognition() !== null;

  function start(): void {
    const Ctor = getSpeechRecognition();
    if (!Ctor) return;
    const r = new Ctor();
    r.continuous = true;
    r.interimResults = false;
    r.lang = navigator.language || 'en-CA';
    r.onresult = (ev) => {
      const text = Array.from(ev.results, (alt) => alt[0]?.transcript ?? '').join(' ');
      onChange(`${value}${value.endsWith(' ') || value.length === 0 ? '' : ' '}${text}`.trim());
    };
    r.onerror = () => setListening(false);
    r.onend = () => setListening(false);
    r.start();
    recogRef.current = r;
    setListening(true);
  }

  function stop(): void {
    recogRef.current?.stop();
    recogRef.current = null;
    setListening(false);
  }

  useEffect(() => {
    return () => {
      recogRef.current?.stop();
      recogRef.current = null;
    };
  }, []);

  return (
    <div className={cn('relative', className)}>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        placeholder={placeholder}
        className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 pr-10 text-sm leading-relaxed text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
      />
      {supported ? (
        <button
          type="button"
          onClick={listening ? stop : start}
          aria-label={listening ? 'Stop voice transcription' : 'Start voice transcription'}
          className={cn(
            'absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-md border border-input bg-card focus:outline-none focus:ring-2 focus:ring-ring',
            listening ? 'text-status-rejected' : 'text-muted-foreground hover:bg-muted',
          )}
        >
          {listening ? <MicOff className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}
        </button>
      ) : null}
      {/* priv-F3 close-out: webkitSpeechRecognition (Chrome/Edge)
          routes audio to Google's servers for transcription. We don't
          call a third party, but the browser API does on our behalf.
          CLAUDE.md non-negotiable #3 demands explicit opt-in for any
          third-party data flow, so we surface it unconditionally where
          the API is available. Where it isn't, the fallback note runs. */}
      {supported ? (
        <div className="mt-1 text-[10px] text-muted-foreground">
          Voice transcription on this browser may route audio to the browser vendor (e.g. Google on
          Chrome). For sensitive content, hand-type instead.
        </div>
      ) : (
        <div className="mt-1 text-[10px] text-muted-foreground">
          Voice input not supported in this browser. Type instead.
        </div>
      )}
    </div>
  );
}
