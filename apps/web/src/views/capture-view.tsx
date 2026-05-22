// /capture — Capture-to-Record 5-stage flow (ADR-0006).
//
//   idle      → permissions check + start
//   capturing → live <video> with getUserMedia, tap to snap to <canvas>
//   preview   → review + retake + add more
//   drafting  → caption + GPS + encrypt + upload + finalize
//   confirmed → receipt with evidence IDs
//
// Photos NEVER enter the camera roll. The browser holds the
// MediaStream → renders into <video> → snaps into <canvas> → reads
// PNG bytes → encrypts via sealEvidence() → PUTs ciphertext to Tigris
// → POSTs metadata to /api/evidence. The raw photo bytes never leave
// in-process memory unencrypted.

import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Camera, Check, ChevronLeft, Loader2, Lock, MapPin, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { evidenceApi, EvidenceApiError } from '@/evidence/api';
import { b64ToBytes, bytesToB64, sealEvidence } from '@/evidence/crypto';
import { evidenceLinkedType, type EvidenceLinkedType } from '@jhsc/shared-types';
import { VoiceToText } from '@/evidence/components';

type Stage = 'idle' | 'capturing' | 'preview' | 'drafting' | 'confirmed';

interface CapturedPhoto {
  readonly bytes: Uint8Array;
  readonly mimeType: 'image/png';
  readonly previewUrl: string;
}

interface UploadedEvidence {
  readonly id: string;
}

interface SessionPayload {
  readonly workplaceKey: { id: string; publicKeyB64: string } | null;
}

export function CaptureView(): JSX.Element {
  const [params] = useSearchParams();
  const linkedTypeRaw = params.get('linkedType') ?? '';
  const linkedId = params.get('linkedId') ?? '';
  const navigate = useNavigate();

  // Guard the entry: linkedType + linkedId must be valid before we
  // open the camera. Sends the rep back to action items if not.
  if (!evidenceLinkedType.includes(linkedTypeRaw as EvidenceLinkedType) || !linkedId) {
    return (
      <div className="mx-auto max-w-md p-6 text-sm text-muted-foreground">
        Capture needs a linked entity. Open this view from a hazard or action-item detail.
        <div className="mt-3">
          <Button asChild size="sm" variant="outline">
            <Link to="/hazards">Back to hazards</Link>
          </Button>
        </div>
      </div>
    );
  }
  const linkedType = linkedTypeRaw as EvidenceLinkedType;

  return <CaptureInner linkedType={linkedType} linkedId={linkedId} onDone={() => navigate(-1)} />;
}

function CaptureInner({
  linkedType,
  linkedId,
  onDone,
}: {
  linkedType: EvidenceLinkedType;
  linkedId: string;
  onDone: () => void;
}): JSX.Element {
  const [stage, setStage] = useState<Stage>('idle');
  const [photos, setPhotos] = useState<CapturedPhoto[]>([]);
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploaded, setUploaded] = useState<UploadedEvidence[]>([]);
  const [coords, setCoords] = useState<GeolocationPosition | null>(null);

  function reset(): void {
    photos.forEach((p) => URL.revokeObjectURL(p.previewUrl));
    setPhotos([]);
    setDescription('');
    setUploaded([]);
    setStage('idle');
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col bg-slate-900 text-white">
      <header className="flex items-center justify-between px-4 py-3">
        <button
          type="button"
          onClick={() => (stage === 'idle' ? onDone() : reset())}
          className="inline-flex items-center text-sm text-slate-300 hover:text-white focus:outline-none focus:ring-2 focus:ring-ring"
        >
          {stage === 'idle' ? <ChevronLeft className="h-4 w-4" /> : <X className="h-4 w-4" />}
          <span className="ml-1">{stage === 'idle' ? 'Back' : 'Cancel'}</span>
        </button>
        <div className="text-xs uppercase tracking-wide text-slate-400">
          {stage} · {photos.length} photo{photos.length === 1 ? '' : 's'}
        </div>
      </header>

      {error ? (
        <div
          role="alert"
          aria-live="polite"
          className="mx-4 mb-2 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200"
        >
          {error}
        </div>
      ) : null}

      <div className="flex-1 overflow-y-auto px-4 pb-24">
        {stage === 'idle' && (
          <IdleStage onStart={() => setStage('capturing')} linkedType={linkedType} />
        )}
        {stage === 'capturing' && (
          <CaptureStage
            onSnap={(photo) => {
              setPhotos((prev) => [...prev, photo]);
              setStage('preview');
            }}
            onError={setError}
          />
        )}
        {stage === 'preview' && (
          <PreviewStage
            photos={photos}
            onRetake={() => {
              const dropped = photos.at(-1);
              if (dropped) URL.revokeObjectURL(dropped.previewUrl);
              setPhotos((prev) => prev.slice(0, -1));
              setStage('capturing');
            }}
            onAddMore={() => setStage('capturing')}
            onContinue={() => setStage('drafting')}
          />
        )}
        {stage === 'drafting' && (
          <DraftingStage
            photoCount={photos.length}
            description={description}
            onDescriptionChange={setDescription}
            coords={coords}
            onCoordsChange={setCoords}
            uploading={uploading}
            onSubmit={async () => {
              setError(null);
              setUploading(true);
              try {
                const sessionRes = await fetch('/api/auth/session', {
                  credentials: 'same-origin',
                  headers: { 'X-Requested-With': 'jhsc-web' },
                });
                if (!sessionRes.ok) throw new Error('session lookup failed');
                const session = (await sessionRes.json()) as SessionPayload;
                if (!session.workplaceKey) {
                  throw new Error('Workplace key not available — sign in again to fix.');
                }
                const publicKey = b64ToBytes(session.workplaceKey.publicKeyB64);
                const results: UploadedEvidence[] = [];
                for (const photo of photos) {
                  const sealed = await sealEvidence(photo.bytes, publicKey);
                  const presign = await evidenceApi.uploadUrl(
                    'image/png',
                    sealed.ciphertext.length,
                  );
                  await evidenceApi.putToTigris(presign.uploadUrl, sealed.ciphertext, 'image/png');
                  const finalized = await evidenceApi.finalize({
                    storageKey: presign.storageKey,
                    ciphertextSha256: sealed.ciphertextSha256,
                    sealedDekB64: bytesToB64(sealed.sealedDek),
                    plaintextSha256: sealed.plaintextSha256,
                    workplaceKeyId: presign.workplaceKeyId,
                    mimeType: 'image/png',
                    byteSize: sealed.ciphertext.length,
                    capturedAt: new Date().toISOString(),
                    gpsLatitude:
                      coords !== null ? Number(coords.coords.latitude.toFixed(4)) : undefined,
                    gpsLongitude:
                      coords !== null ? Number(coords.coords.longitude.toFixed(4)) : undefined,
                    gpsAccuracyM:
                      coords !== null ? Number(coords.coords.accuracy.toFixed(2)) : undefined,
                    linkedType,
                    linkedId,
                  });
                  results.push({ id: finalized.id });
                }
                setUploaded(results);
                setStage('confirmed');
              } catch (e) {
                if (e instanceof EvidenceApiError) {
                  setError(`Upload failed (HTTP ${e.status}). Try again.`);
                } else {
                  setError(e instanceof Error ? e.message : String(e));
                }
              } finally {
                setUploading(false);
              }
            }}
          />
        )}
        {stage === 'confirmed' && <ConfirmedStage uploaded={uploaded} onDone={onDone} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stage: idle
// ---------------------------------------------------------------------------

function IdleStage({
  onStart,
  linkedType,
}: {
  onStart: () => void;
  linkedType: EvidenceLinkedType;
}): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-slate-800">
        <Camera className="h-6 w-6 text-slate-200" strokeWidth={1.75} aria-hidden="true" />
      </div>
      <div className="text-lg font-semibold">Capture evidence</div>
      <p className="mt-1 max-w-xs text-sm text-slate-400">
        Linked to {linkedType.replace(/_/g, ' ')}. Photos are encrypted in this device before
        upload. Camera roll is never touched.
      </p>
      <div className="mt-6">
        <Button type="button" onClick={onStart}>
          Open camera
        </Button>
      </div>
      <p className="mt-6 flex items-center gap-1 text-xs text-slate-500">
        <Lock className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
        Workplace public key seals each file before upload.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stage: capturing
// ---------------------------------------------------------------------------

function CaptureStage({
  onSnap,
  onError,
}: {
  onSnap: (p: CapturedPhoto) => void;
  onError: (msg: string) => void;
}): JSX.Element {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.onloadedmetadata = () => setReady(true);
        }
      } catch (e) {
        onError(e instanceof Error ? e.message : 'Camera permission denied.');
      }
    })();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [onError]);

  async function snap(): Promise<void> {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      onError('Canvas not supported');
      return;
    }
    ctx.drawImage(video, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) {
      onError('Failed to read frame');
      return;
    }
    const arrayBuf = await blob.arrayBuffer();
    const bytes = new Uint8Array(arrayBuf);
    const previewUrl = URL.createObjectURL(blob);
    onSnap({ bytes, mimeType: 'image/png', previewUrl });
  }

  return (
    <div className="flex flex-col items-center gap-4">
      <div className="relative w-full overflow-hidden rounded-lg bg-black">
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="w-full"
          aria-label="Camera preview"
        />
        <canvas ref={canvasRef} className="hidden" />
      </div>
      <Button type="button" disabled={!ready} onClick={snap} className="h-14 w-14 rounded-full p-0">
        <Camera className="h-6 w-6" strokeWidth={2} aria-hidden="true" />
        <span className="sr-only">Snap</span>
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stage: preview
// ---------------------------------------------------------------------------

function PreviewStage({
  photos,
  onRetake,
  onAddMore,
  onContinue,
}: {
  photos: CapturedPhoto[];
  onRetake: () => void;
  onAddMore: () => void;
  onContinue: () => void;
}): JSX.Element {
  const latest = photos.at(-1);
  return (
    <div className="flex flex-col items-center gap-4">
      {latest ? (
        <img
          src={latest.previewUrl}
          alt={`Captured photo ${photos.length}`}
          className="w-full rounded-lg"
        />
      ) : null}
      <div className="flex w-full flex-wrap justify-center gap-2">
        <Button type="button" variant="outline" onClick={onRetake}>
          Retake
        </Button>
        <Button type="button" variant="outline" onClick={onAddMore}>
          Add another
        </Button>
        <Button type="button" onClick={onContinue}>
          Continue
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stage: drafting
// ---------------------------------------------------------------------------

function DraftingStage({
  photoCount,
  description,
  onDescriptionChange,
  coords,
  onCoordsChange,
  uploading,
  onSubmit,
}: {
  photoCount: number;
  description: string;
  onDescriptionChange: (next: string) => void;
  coords: GeolocationPosition | null;
  onCoordsChange: (c: GeolocationPosition) => void;
  uploading: boolean;
  onSubmit: () => void;
}): JSX.Element {
  function getCoords(): void {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(onCoordsChange, () => {
      // Ignore permission denied — coords stay null, the row goes
      // without GPS metadata.
    });
  }

  return (
    <div className="space-y-4 py-4">
      <div className="text-sm text-slate-300">
        {photoCount} photo{photoCount === 1 ? '' : 's'} ready to encrypt + upload.
      </div>
      <div className="space-y-1">
        <label htmlFor="cap-desc" className="text-xs uppercase tracking-wide text-slate-400">
          Description (optional)
        </label>
        <VoiceToText
          value={description}
          onChange={onDescriptionChange}
          rows={4}
          placeholder="What's in the photo? What's the immediate concern?"
        />
      </div>
      <div className="flex items-center justify-between gap-3 rounded-md border border-slate-700 bg-slate-800/50 p-3">
        <div className="flex items-center gap-2">
          <MapPin className="h-4 w-4 text-slate-300" strokeWidth={1.75} aria-hidden="true" />
          <div className="text-xs text-slate-300">
            {coords ? (
              <span>
                {coords.coords.latitude.toFixed(4)}, {coords.coords.longitude.toFixed(4)} (±
                {Math.round(coords.coords.accuracy)} m)
              </span>
            ) : (
              'No GPS attached'
            )}
          </div>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={getCoords}>
          {coords ? 'Refresh' : 'Attach GPS'}
        </Button>
      </div>
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-700 bg-slate-900/95 p-3 backdrop-blur">
        <div className="mx-auto flex max-w-md items-center justify-end gap-2">
          <Button type="button" onClick={onSubmit} disabled={uploading}>
            {uploading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} aria-hidden="true" />
                Encrypting…
              </>
            ) : (
              <>Encrypt + upload</>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stage: confirmed
// ---------------------------------------------------------------------------

function ConfirmedStage({
  uploaded,
  onDone,
}: {
  uploaded: UploadedEvidence[];
  onDone: () => void;
}): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <div
        className={cn(
          'mb-3 flex h-14 w-14 items-center justify-center rounded-full',
          'bg-emerald-500/20 text-emerald-300',
        )}
      >
        <Check className="h-6 w-6" strokeWidth={2.5} aria-hidden="true" />
      </div>
      <div className="text-lg font-semibold">
        {uploaded.length} evidence file{uploaded.length === 1 ? '' : 's'} uploaded
      </div>
      <p className="mt-1 max-w-xs text-sm text-slate-400">
        Each file is encrypted at rest with the workplace public key. The plaintext SHA-256 is
        anchored in the audit chain.
      </p>
      <div className="mt-4 space-y-1 font-mono text-[11px] text-slate-500">
        {uploaded.map((u) => (
          <div key={u.id}>{u.id.slice(0, 8)}…</div>
        ))}
      </div>
      <div className="mt-6">
        <Button type="button" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}
