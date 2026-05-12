import React, { useState, useEffect, useRef } from 'react';
import {
  Camera,
  X,
  ArrowLeft,
  Check,
  ChevronRight,
  MapPin,
  Clock,
  Lock,
  Image as ImageIcon,
  AlertTriangle,
  Hash,
  Mic,
  Zap,
  ZapOff,
  RotateCcw,
  Plus,
  Loader2,
  CheckCircle2,
  CircleDot,
  Sparkles,
  Edit3,
  Type,
  ChevronDown,
} from 'lucide-react';

// Five-stage flow: idle → capturing → preview → drafting → confirmed
export default function CaptureToRecord() {
  const [stage, setStage] = useState('idle');
  const [photoCount, setPhotoCount] = useState(0);

  return (
    <div className="min-h-screen bg-slate-900 text-white antialiased" style={{ fontFamily: 'Inter, -apple-system, system-ui, sans-serif' }}>
      {stage === 'idle' && <IdleStage onStart={() => setStage('capturing')} />}
      {stage === 'capturing' && <CapturingStage onCapture={() => { setPhotoCount(photoCount + 1); setStage('preview'); }} onCancel={() => setStage('idle')} />}
      {stage === 'preview' && <PreviewStage onConfirm={() => setStage('drafting')} onRetake={() => setStage('capturing')} onAddMore={() => setStage('capturing')} photoCount={photoCount} />}
      {stage === 'drafting' && <DraftingStage onSave={() => setStage('confirmed')} photoCount={photoCount} />}
      {stage === 'confirmed' && <ConfirmedStage onDone={() => { setStage('idle'); setPhotoCount(0); }} />}
    </div>
  );
}

// =================== Stage: Idle (showing the FAB context) ===================
function IdleStage({ onStart }) {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 relative" style={{ fontFamily: 'Inter, sans-serif' }}>
      {/* Mock app background */}
      <div className="px-4 py-6">
        <div className="text-xs text-slate-500 font-medium mb-1 tabular-nums">Tuesday · May 12, 2026</div>
        <div className="text-2xl font-semibold tracking-tight mb-1">Good afternoon.</div>
        <div className="text-sm text-slate-500 mb-6">3 items need your attention today.</div>

        <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-2.5">Open hazards</div>
        <div className="space-y-2">
          {[
            { id: 'H-047', label: 'WBV — dock cycle', age: '12d', sev: 'bg-red-500' },
            { id: 'H-046', label: 'Slip — cooler floor', age: '4d', sev: 'bg-orange-500' },
            { id: 'H-044', label: 'Noise — compressor', age: '2d', sev: 'bg-amber-500' },
          ].map((h) => (
            <div key={h.id} className="bg-white border border-slate-200 rounded-lg p-3 flex items-center gap-3">
              <span className={`block w-1.5 h-1.5 rounded-full ${h.sev}`} />
              <span className="text-[11px] font-mono text-slate-500 tabular-nums">{h.id}</span>
              <span className="text-sm flex-1">{h.label}</span>
              <span className="text-xs text-slate-500 tabular-nums">{h.age}</span>
            </div>
          ))}
        </div>
      </div>

      {/* FAB with explanatory callout */}
      <div className="fixed bottom-6 right-4 z-30">
        <div className="absolute bottom-full right-0 mb-3 mr-1 w-64 animate-in fade-in slide-in-from-bottom-2 duration-300">
          <div className="bg-slate-900 text-white rounded-xl shadow-2xl shadow-slate-900/40 p-3.5">
            <div className="flex items-start gap-2 mb-1">
              <Sparkles className="w-3.5 h-3.5 text-amber-300 mt-0.5 shrink-0" strokeWidth={2} />
              <div className="text-[11px] font-semibold uppercase tracking-wide text-amber-300">Capture-to-Record</div>
            </div>
            <div className="text-xs text-white/90 leading-relaxed mb-1">
              Tap the camera button to start. The next 30 seconds is everything that matters.
            </div>
            <div className="text-[10px] text-white/50">
              Photo → encrypted hazard draft, ready in your pocket.
            </div>
            <div className="absolute -bottom-1.5 right-6 w-3 h-3 bg-slate-900 rotate-45" />
          </div>
        </div>
        <button
          onClick={onStart}
          className="w-16 h-16 rounded-full bg-slate-900 text-white shadow-2xl shadow-slate-900/30 flex items-center justify-center active:scale-95 transition-transform animate-pulse-ring"
        >
          <Camera className="w-7 h-7" strokeWidth={2} />
        </button>
      </div>

      <style>{`
        @keyframes pulse-ring {
          0% { box-shadow: 0 0 0 0 rgba(15, 23, 42, 0.4), 0 20px 40px -10px rgba(15, 23, 42, 0.3); }
          100% { box-shadow: 0 0 0 16px rgba(15, 23, 42, 0), 0 20px 40px -10px rgba(15, 23, 42, 0.3); }
        }
        .animate-pulse-ring { animation: pulse-ring 2s infinite; }
      `}</style>
    </div>
  );
}

// =================== Stage: Capturing ===================
function CapturingStage({ onCapture, onCancel }) {
  const [flashOn, setFlashOn] = useState(false);
  const [gpsLocked, setGpsLocked] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setGpsLocked(true), 800);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="fixed inset-0 bg-black flex flex-col" style={{ fontFamily: 'Inter, sans-serif' }}>
      {/* Top bar */}
      <div className="absolute top-0 left-0 right-0 z-10 pt-[env(safe-area-inset-top)]">
        <div className="flex items-center justify-between p-4">
          <button onClick={onCancel} className="h-10 w-10 rounded-full bg-black/40 backdrop-blur flex items-center justify-center text-white">
            <X className="w-5 h-5" strokeWidth={2} />
          </button>
          <div className="px-3 py-1.5 rounded-full bg-black/40 backdrop-blur flex items-center gap-1.5">
            <Lock className="w-3 h-3 text-white" strokeWidth={2.5} />
            <span className="text-[11px] font-medium text-white">Encrypted at capture</span>
          </div>
          <button onClick={() => setFlashOn(!flashOn)} className="h-10 w-10 rounded-full bg-black/40 backdrop-blur flex items-center justify-center text-white">
            {flashOn ? <Zap className="w-5 h-5 text-amber-300" strokeWidth={2} /> : <ZapOff className="w-5 h-5" strokeWidth={2} />}
          </button>
        </div>
      </div>

      {/* Camera viewport (mock) */}
      <div className="flex-1 relative bg-gradient-to-b from-slate-800 via-slate-700 to-slate-900 overflow-hidden">
        {/* Mock dock floor visualization */}
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="w-full h-full" style={{
            backgroundImage: `
              linear-gradient(180deg, transparent 60%, rgba(0,0,0,0.4)),
              repeating-linear-gradient(90deg, rgba(255,255,255,0.04) 0 60px, rgba(255,255,255,0.08) 60px 62px)
            `,
          }}>
            <div className="absolute inset-x-0 top-[55%] h-[3px] bg-slate-600" />
            <div className="absolute inset-x-0 top-[55%] h-12 bg-gradient-to-b from-black/30 to-black/60" style={{ clipPath: 'polygon(0 0, 100% 0, 96% 100%, 4% 100%)' }} />
          </div>
        </div>

        {/* Center reticle */}
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="w-64 h-64 border border-white/30 rounded-lg">
            <div className="absolute -top-0.5 -left-0.5 w-4 h-4 border-t-2 border-l-2 border-white" />
            <div className="absolute -top-0.5 -right-0.5 w-4 h-4 border-t-2 border-r-2 border-white" />
            <div className="absolute -bottom-0.5 -left-0.5 w-4 h-4 border-b-2 border-l-2 border-white" />
            <div className="absolute -bottom-0.5 -right-0.5 w-4 h-4 border-b-2 border-r-2 border-white" />
          </div>
        </div>

        {/* Bottom metadata strip */}
        <div className="absolute bottom-32 left-0 right-0 flex justify-center px-4">
          <div className="bg-black/50 backdrop-blur-md rounded-lg px-3 py-2 flex items-center gap-3 text-[11px] text-white/90">
            <span className="flex items-center gap-1">
              {gpsLocked ? (
                <>
                  <MapPin className="w-3 h-3 text-emerald-400" strokeWidth={2.25} />
                  <span className="tabular-nums">43.6481° N · 79.7976° W</span>
                </>
              ) : (
                <>
                  <Loader2 className="w-3 h-3 animate-spin" strokeWidth={2.25} />
                  <span>Locating…</span>
                </>
              )}
            </span>
            <span className="text-white/30">·</span>
            <span className="tabular-nums">May 12, 2026 · 14:32:08</span>
          </div>
        </div>
      </div>

      {/* Shutter row */}
      <div className="bg-black p-6 pb-[env(safe-area-inset-bottom)]" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 24px)' }}>
        <div className="flex items-center justify-around max-w-md mx-auto">
          <button className="h-12 w-12 rounded-lg bg-slate-800 flex items-center justify-center text-white/80">
            <ImageIcon className="w-5 h-5" strokeWidth={2} />
          </button>
          <button onClick={onCapture} className="h-20 w-20 rounded-full border-4 border-white flex items-center justify-center active:scale-95 transition-transform">
            <div className="w-16 h-16 rounded-full bg-white" />
          </button>
          <button className="h-12 w-12 rounded-lg bg-slate-800 flex items-center justify-center text-white/80">
            <RotateCcw className="w-5 h-5" strokeWidth={2} />
          </button>
        </div>
      </div>
    </div>
  );
}

// =================== Stage: Preview ===================
function PreviewStage({ onConfirm, onRetake, onAddMore, photoCount }) {
  return (
    <div className="fixed inset-0 bg-black flex flex-col text-white" style={{ fontFamily: 'Inter, sans-serif' }}>
      <div className="flex items-center justify-between p-4 pt-[calc(env(safe-area-inset-top)+12px)]">
        <button onClick={onRetake} className="h-10 px-3 rounded-md bg-white/10 backdrop-blur text-white text-xs font-medium flex items-center gap-1.5">
          <ArrowLeft className="w-3.5 h-3.5" strokeWidth={2} /> Retake
        </button>
        <div className="text-xs text-white/60 tabular-nums">{photoCount} photo{photoCount !== 1 && 's'}</div>
        <button onClick={onConfirm} className="h-10 px-4 rounded-md bg-white text-slate-900 text-xs font-semibold flex items-center gap-1.5">
          Use this <ChevronRight className="w-3.5 h-3.5" strokeWidth={2} />
        </button>
      </div>

      <div className="flex-1 flex items-center justify-center p-4 overflow-hidden">
        <div className="relative w-full max-w-md aspect-[3/4] rounded-xl overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-b from-slate-700 via-slate-800 to-slate-900" style={{
            backgroundImage: `
              linear-gradient(180deg, transparent 50%, rgba(0,0,0,0.5)),
              repeating-linear-gradient(90deg, rgba(255,255,255,0.04) 0 60px, rgba(255,255,255,0.08) 60px 62px)
            `,
          }}>
            <div className="absolute inset-x-4 top-[55%] h-1 bg-slate-600 rounded-full" />
            <div className="absolute inset-x-0 top-[55%] h-12 bg-gradient-to-b from-black/40 to-black/70" style={{ clipPath: 'polygon(0 0, 100% 0, 94% 100%, 6% 100%)' }} />
          </div>

          {/* Encrypted overlay badge */}
          <div className="absolute top-3 left-3 flex items-center gap-1.5 px-2 py-1 rounded-md bg-black/50 backdrop-blur text-[10px] font-medium text-white">
            <Lock className="w-2.5 h-2.5" strokeWidth={2.5} />
            Encrypted · 4.2 MB
          </div>

          {/* Hash badge */}
          <div className="absolute top-3 right-3 flex items-center gap-1 px-2 py-1 rounded-md bg-black/50 backdrop-blur text-[10px] font-mono tabular-nums text-white/90">
            <Hash className="w-2.5 h-2.5" strokeWidth={2.5} />
            7b21d9f4
          </div>

          {/* Metadata strip */}
          <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/90 to-transparent p-3">
            <div className="text-xs text-white/90 mb-1">
              43.6481° N · 79.7976° W
            </div>
            <div className="text-[11px] text-white/60 tabular-nums">
              May 12, 2026 · 14:32:08 · iPhone 15 Pro
            </div>
          </div>
        </div>
      </div>

      <div className="bg-black/60 backdrop-blur-md border-t border-white/10 p-4 pb-[calc(env(safe-area-inset-bottom)+16px)]">
        <button onClick={onAddMore} className="w-full h-12 rounded-md bg-white/10 text-white text-sm font-medium flex items-center justify-center gap-2 mb-2 active:bg-white/20">
          <Plus className="w-4 h-4" strokeWidth={2} /> Take another photo
        </button>
        <div className="text-[11px] text-white/50 text-center">
          Photo lives in encrypted local storage. Never written to your camera roll.
        </div>
      </div>
    </div>
  );
}

// =================== Stage: Drafting ===================
function DraftingStage({ onSave, photoCount }) {
  const [severity, setSeverity] = useState('');
  const [title, setTitle] = useState('Whole-body vibration — dock crossing');
  const [location, setLocation] = useState('Loading dock — trench drain crossing');

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col" style={{ fontFamily: 'Inter, sans-serif' }}>
      {/* Header */}
      <div className="bg-white border-b border-slate-200 sticky top-0 z-10" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
        <div className="px-4 py-3 flex items-center justify-between">
          <button className="h-9 w-9 -ml-2 rounded-md hover:bg-slate-100 flex items-center justify-center">
            <X className="w-5 h-5 text-slate-600" strokeWidth={2} />
          </button>
          <div className="text-xs font-medium text-slate-500">Draft hazard · Auto-saving</div>
          <button className="h-9 w-9 -mr-2 rounded-md hover:bg-slate-100 flex items-center justify-center">
            <Type className="w-4 h-4 text-slate-600" strokeWidth={2} />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto pb-24">
        <div className="px-4 py-4">
          {/* Photo tile + capture meta */}
          <div className="mb-5">
            <div className="flex gap-2 mb-2">
              {Array.from({ length: Math.max(photoCount, 1) }).map((_, i) => (
                <div key={i} className="relative w-20 h-20 rounded-lg overflow-hidden border border-slate-200">
                  <div className="absolute inset-0 bg-gradient-to-br from-slate-600 to-slate-900" style={{
                    backgroundImage: `repeating-linear-gradient(90deg, rgba(255,255,255,0.04) 0 12px, rgba(255,255,255,0.08) 12px 13px)`,
                  }} />
                  <div className="absolute top-1 right-1">
                    <Lock className="w-2.5 h-2.5 text-white/80" strokeWidth={2.5} />
                  </div>
                </div>
              ))}
              <button className="w-20 h-20 rounded-lg border border-dashed border-slate-300 flex flex-col items-center justify-center text-slate-500 active:bg-slate-100">
                <Plus className="w-4 h-4" strokeWidth={2} />
                <span className="text-[10px] font-medium mt-0.5">More</span>
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
              <span className="inline-flex items-center gap-1 tabular-nums">
                <MapPin className="w-3 h-3 text-emerald-600" strokeWidth={2.25} />
                GPS captured · 6m accuracy
              </span>
              <span className="inline-flex items-center gap-1">
                <Lock className="w-3 h-3" strokeWidth={2.25} />
                Encrypted at capture
              </span>
            </div>
          </div>

          {/* Auto-detected suggestion */}
          <div className="mb-5 p-3 rounded-lg bg-blue-50 border border-blue-100">
            <div className="flex items-start gap-2.5">
              <Sparkles className="w-4 h-4 text-blue-700 mt-0.5 shrink-0" strokeWidth={2} />
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium text-blue-900 mb-0.5">
                  Auto-suggested from this location
                </div>
                <div className="text-[11px] text-blue-800 mb-2 leading-relaxed">
                  Previous hazards at this GPS pin involved WBV/MSD exposure. Pre-filled below — you can edit anything.
                </div>
                <div className="flex items-center gap-1.5 text-[10px] font-medium text-blue-700">
                  <button className="hover:underline">Accept</button>
                  <span className="text-blue-300">·</span>
                  <button className="hover:underline">Start blank</button>
                </div>
              </div>
            </div>
          </div>

          {/* Form fields */}
          <Field label="Title" required>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full h-11 px-3 rounded-md border border-slate-200 bg-white text-[15px] focus:border-slate-400 focus:outline-none"
            />
          </Field>

          <Field label="Severity" required help="How serious is the immediate risk to workers?">
            <div className="grid grid-cols-4 gap-1.5">
              {[
                { id: 'low', label: 'Low', dot: 'bg-slate-400' },
                { id: 'medium', label: 'Medium', dot: 'bg-amber-500' },
                { id: 'high', label: 'High', dot: 'bg-orange-500' },
                { id: 'critical', label: 'Critical', dot: 'bg-red-500' },
              ].map((opt) => (
                <button
                  key={opt.id}
                  onClick={() => setSeverity(opt.id)}
                  className={`h-11 px-2 rounded-md border text-xs font-medium flex items-center justify-center gap-1.5 transition-all ${
                    severity === opt.id
                      ? 'bg-slate-900 text-white border-slate-900'
                      : 'bg-white text-slate-700 border-slate-200'
                  }`}
                >
                  <span className={`block w-1.5 h-1.5 rounded-full ${opt.dot}`} />
                  {opt.label}
                </button>
              ))}
            </div>
          </Field>

          <Field label="Location">
            <input
              type="text"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              className="w-full h-11 px-3 rounded-md border border-slate-200 bg-white text-[15px] focus:border-slate-400 focus:outline-none"
            />
          </Field>

          <Field label="Description" help="What did you observe? Voice-to-text supported.">
            <div className="relative">
              <textarea
                rows={4}
                placeholder="Describe the hazard, the activity that exposed workers to it, and any conditions that contributed…"
                className="w-full px-3 py-2.5 rounded-md border border-slate-200 bg-white text-[15px] focus:border-slate-400 focus:outline-none resize-none"
              />
              <button className="absolute bottom-2 right-2 h-8 w-8 rounded-md bg-slate-900 text-white flex items-center justify-center active:scale-95">
                <Mic className="w-4 h-4" strokeWidth={2} />
              </button>
            </div>
          </Field>

          <details className="mt-4 mb-2 border border-slate-200 rounded-lg overflow-hidden">
            <summary className="px-3.5 py-3 flex items-center justify-between cursor-pointer hover:bg-slate-50 list-none">
              <div>
                <div className="text-sm font-medium text-slate-900">Optional details</div>
                <div className="text-[11px] text-slate-500">Reporter, witnesses, controls, equipment IDs</div>
              </div>
              <ChevronDown className="w-4 h-4 text-slate-500" strokeWidth={2} />
            </summary>
            <div className="px-3.5 pb-3.5 pt-1 space-y-3 border-t border-slate-100">
              <div className="text-xs text-slate-500">Expanded fields would appear here…</div>
            </div>
          </details>
        </div>
      </div>

      {/* Sticky bottom action */}
      <div className="fixed bottom-0 inset-x-0 bg-white border-t border-slate-200 p-3" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 12px)' }}>
        <div className="flex items-center gap-2 max-w-md mx-auto">
          <button className="h-12 px-4 rounded-md border border-slate-200 text-xs font-medium text-slate-700 active:bg-slate-50">
            Save draft
          </button>
          <button
            onClick={onSave}
            disabled={!severity}
            className={`flex-1 h-12 rounded-md text-sm font-semibold flex items-center justify-center gap-2 transition-colors ${
              severity ? 'bg-slate-900 text-white active:bg-slate-800' : 'bg-slate-200 text-slate-400'
            }`}
          >
            <Check className="w-4 h-4" strokeWidth={2.25} />
            Create hazard
          </button>
        </div>
        <div className="text-[10px] text-center text-slate-500 mt-2">
          Audit-logged · Linked to GPS pin · Encrypted at rest
        </div>
      </div>
    </div>
  );
}

function Field({ label, required, help, children }) {
  return (
    <div className="mb-4">
      <div className="flex items-baseline justify-between mb-1.5">
        <label className="text-xs font-semibold text-slate-700 uppercase tracking-wide">
          {label} {required && <span className="text-red-500">*</span>}
        </label>
      </div>
      {children}
      {help && <div className="text-[11px] text-slate-500 mt-1">{help}</div>}
    </div>
  );
}

// =================== Stage: Confirmed ===================
function ConfirmedStage({ onDone }) {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col items-center justify-center p-6" style={{ fontFamily: 'Inter, sans-serif' }}>
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center text-center mb-8">
          <div className="w-16 h-16 rounded-full bg-emerald-500 flex items-center justify-center mb-5 animate-in zoom-in duration-300">
            <Check className="w-8 h-8 text-white" strokeWidth={2.5} />
          </div>
          <div className="text-2xl font-semibold tracking-tight mb-1.5">Hazard H-048 created.</div>
          <div className="text-sm text-slate-500 leading-relaxed">
            Encrypted, GPS-pinned, hash-fingerprinted, and entered in your audit chain.
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden mb-4">
          <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-2">
            <span className="block w-1.5 h-1.5 rounded-full bg-red-500" />
            <span className="text-[11px] font-mono text-slate-500 tabular-nums">H-048</span>
            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded border bg-red-50 text-red-700 border-red-100 uppercase tracking-wide">Open</span>
            <span className="ml-auto text-[10px] text-slate-500 tabular-nums">just now</span>
          </div>
          <div className="px-4 py-3">
            <div className="text-sm font-medium text-slate-900 mb-1">Whole-body vibration — dock crossing</div>
            <div className="text-xs text-slate-500 leading-relaxed">
              Loading dock — trench drain crossing · 1 photo · GPS pinned
            </div>
          </div>
          <div className="px-4 py-2.5 bg-slate-50 border-t border-slate-100 flex items-center justify-between text-[10px] font-mono text-slate-500 tabular-nums">
            <div className="flex items-center gap-1.5">
              <Hash className="w-3 h-3" strokeWidth={2} />
              sha256 a3f4...b21d
            </div>
            <div className="flex items-center gap-1.5">
              <Lock className="w-3 h-3" strokeWidth={2} />
              Audit entry 124
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <button onClick={onDone} className="w-full h-12 rounded-md bg-slate-900 text-white text-sm font-medium active:bg-slate-800">
            View hazard
          </button>
          <button className="w-full h-12 rounded-md border border-slate-200 text-slate-700 text-sm font-medium flex items-center justify-center gap-1.5 active:bg-slate-50">
            <Edit3 className="w-4 h-4" strokeWidth={2} />
            Link to recommendation
          </button>
          <button onClick={onDone} className="w-full h-12 rounded-md text-slate-600 text-sm font-medium active:bg-slate-100">
            Back to dashboard
          </button>
        </div>

        <div className="mt-6 text-center">
          <div className="inline-flex items-center gap-1.5 text-[11px] text-slate-500">
            <Clock className="w-3 h-3" strokeWidth={2} />
            <span className="tabular-nums">Total time: 42 seconds from camera to record</span>
          </div>
        </div>
      </div>
    </div>
  );
}
