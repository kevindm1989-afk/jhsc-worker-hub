import React, { useState, useEffect, useRef } from 'react';
import {
  ArrowLeft,
  X,
  AlertTriangle,
  MapPin,
  Clock,
  User,
  FileText,
  Image as ImageIcon,
  Paperclip,
  MessageSquare,
  Shield,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  Hash,
  ExternalLink,
  Plus,
  CheckCircle2,
  Circle,
  AlertCircle,
  Calendar,
  Camera,
  Mic,
  MoreHorizontal,
  Eye,
  Download,
  Lock,
  Activity,
  Quote,
  BookOpen,
  ArrowUpRight,
  Edit3,
} from 'lucide-react';

// =================== Citation hover content (mock corpus) ===================
const CORPUS = {
  'ohsa-s9-20': {
    statute: 'OHSA',
    section: 's. 9(20)',
    title: 'Recommendations of committee',
    summary:
      'A joint health and safety committee may make written recommendations to the constructor or employer for the improvement of the health and safety of workers and shall respond in writing within twenty-one days.',
    versionDate: '2023-06-08',
    sourceUrl: 'https://www.ontario.ca/laws/statute/90o01',
    hash: 'a3f4e2c1',
  },
  'ohsa-s9-21': {
    statute: 'OHSA',
    section: 's. 9(21)',
    title: 'Response to recommendations',
    summary:
      'The constructor or employer shall respond to written recommendations within twenty-one days. The response shall contain a timetable for implementing recommendations the constructor or employer agrees with and give reasons for disagreement with any recommendation not accepted.',
    versionDate: '2023-06-08',
    sourceUrl: 'https://www.ontario.ca/laws/statute/90o01',
    hash: '7b21d9f4',
  },
  'oreg-851-s11': {
    statute: 'O. Reg. 851',
    section: 's. 11',
    title: 'Powered lifting devices — general',
    summary:
      'A powered lifting device shall be operated only by a competent person, and shall not be loaded beyond its rated working load or operated in a manner that may endanger a worker.',
    versionDate: '2023-06-08',
    sourceUrl: 'https://www.ontario.ca/laws/regulation/900851',
    hash: 'c8e3a17b',
  },
  'iso-2631-1': {
    statute: 'ISO 2631-1',
    section: '1997',
    title: 'Mechanical vibration and shock — Whole-body vibration — General requirements',
    summary:
      'Defines methods for measuring periodic, random and transient whole-body vibration. Establishes Exposure Action Value (EAV) of 0.5 m/s² and Exposure Limit Value (ELV) of 1.15 m/s² over 8 hours.',
    versionDate: '1997 (current edition)',
    sourceUrl: 'https://www.iso.org/standard/7612.html',
    hash: 'iso2631-1',
  },
  'iso-2631-5': {
    statute: 'ISO 2631-5',
    section: '2018',
    title: 'Whole-body vibration — Method for evaluation of vibration containing multiple shocks',
    summary:
      'Provides methods for evaluating the health effects of whole-body vibration containing multiple shocks, particularly relevant to operations involving repeated impacts such as crossing trench drains or dock plates.',
    versionDate: '2018',
    sourceUrl: 'https://www.iso.org/standard/50905.html',
    hash: 'iso2631-5',
  },
};

// =================== Main view ===================
export default function HazardDetailPrototype() {
  const [isDesktop, setIsDesktop] = useState(false);

  useEffect(() => {
    const check = () => setIsDesktop(window.innerWidth >= 1024);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 antialiased" style={{ fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, system-ui, sans-serif' }}>
      {isDesktop ? <DesktopLayout /> : <MobileLayout />}
    </div>
  );
}

// =================== Desktop ===================
function DesktopLayout() {
  return (
    <div className="flex min-h-screen">
      <ListPane />
      <DetailPane onClose={() => {}} embedded />
    </div>
  );
}

function ListPane() {
  const hazards = [
    { id: 'H-047', title: 'WBV exposure — dock cycle', severity: 'critical', status: 'open', age: 12, active: true },
    { id: 'H-046', title: 'Slip hazard — cooler floor', severity: 'high', status: 'pending', age: 4 },
    { id: 'H-045', title: 'MSD — pick line repetition', severity: 'high', status: 'resolved' },
    { id: 'H-044', title: 'Noise — compressor room', severity: 'medium', status: 'open', age: 2 },
    { id: 'H-043', title: 'Trench drain — dock crossing', severity: 'critical', status: 'open', age: 18 },
  ];

  const sev = (s) => ({ critical: 'bg-red-500', high: 'bg-orange-500', medium: 'bg-amber-500' })[s];
  const stat = (s) => ({
    open: 'bg-red-50 text-red-700 border-red-100',
    pending: 'bg-amber-50 text-amber-700 border-amber-100',
    resolved: 'bg-emerald-50 text-emerald-700 border-emerald-100',
  })[s];

  return (
    <div className="w-[380px] border-r border-slate-200 bg-white flex flex-col">
      <div className="px-5 pt-5 pb-3 border-b border-slate-200">
        <div className="text-2xl font-semibold tracking-tight">Hazards</div>
        <div className="text-xs text-slate-500 mt-0.5">4 open · 2 resolved this month</div>
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {hazards.map((h) => (
          <button
            key={h.id}
            className={`w-full text-left px-4 py-3 border-l-2 transition-colors ${
              h.active
                ? 'border-l-slate-900 bg-slate-50'
                : 'border-l-transparent hover:bg-slate-50'
            }`}
          >
            <div className="flex items-start gap-2.5">
              <span className={`block w-1.5 h-1.5 rounded-full ${sev(h.severity)} mt-1.5 shrink-0`} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="text-[11px] font-mono text-slate-500 tabular-nums">{h.id}</span>
                  <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded border uppercase tracking-wide ${stat(h.status)}`}>
                    {h.status}
                  </span>
                </div>
                <div className="text-sm text-slate-900 truncate">{h.title}</div>
                {h.age && (
                  <div className="text-[11px] text-slate-500 mt-0.5 tabular-nums">{h.age}d open</div>
                )}
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

// =================== Mobile ===================
function MobileLayout() {
  return <DetailPane onClose={() => {}} embedded={false} />;
}

// =================== Detail Pane ===================
function DetailPane({ onClose, embedded }) {
  const [showAuditDrawer, setShowAuditDrawer] = useState(false);
  const [activeSection, setActiveSection] = useState('overview');

  return (
    <div className="flex-1 flex flex-col bg-white min-w-0">
      {/* Header */}
      <header className="sticky top-0 z-10 bg-white/95 backdrop-blur border-b border-slate-200">
        <div className="px-4 lg:px-6 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            {!embedded && (
              <button className="h-9 w-9 -ml-2 rounded-lg hover:bg-slate-100 flex items-center justify-center text-slate-700">
                <ArrowLeft className="w-5 h-5" strokeWidth={2} />
              </button>
            )}
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-mono text-slate-500 tabular-nums">H-047</span>
                <span className="block w-1 h-1 rounded-full bg-slate-300" />
                <span className="text-[11px] text-slate-500 tabular-nums">Created May 4, 2026</span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button className="h-9 px-3 rounded-md border border-slate-200 text-xs font-medium text-slate-700 hover:border-slate-300 hover:bg-slate-50 hidden sm:flex items-center gap-1.5">
              <Edit3 className="w-3.5 h-3.5" strokeWidth={2} />
              Edit
            </button>
            <button className="h-9 w-9 rounded-md hover:bg-slate-100 flex items-center justify-center text-slate-600">
              <MoreHorizontal className="w-[18px] h-[18px]" strokeWidth={2} />
            </button>
            {embedded && (
              <button onClick={onClose} className="h-9 w-9 rounded-md hover:bg-slate-100 flex items-center justify-center text-slate-600">
                <X className="w-5 h-5" strokeWidth={2} />
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-4 lg:px-6 py-5">
          {/* Title block */}
          <div className="mb-5">
            <div className="flex items-center gap-2 mb-2">
              <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide px-2 py-1 rounded border bg-red-50 text-red-700 border-red-100">
                <span className="block w-1.5 h-1.5 rounded-full bg-red-500" />
                Critical
              </span>
              <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide px-2 py-1 rounded border bg-red-50 text-red-700 border-red-100">
                Open · 12 days
              </span>
            </div>
            <h1 className="text-xl lg:text-2xl font-semibold tracking-tight text-slate-900 leading-tight">
              Whole-body vibration exposure — loading dock three-stage cycle
            </h1>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-3 text-xs text-slate-500">
              <span className="inline-flex items-center gap-1.5">
                <MapPin className="w-3.5 h-3.5" strokeWidth={2} />
                Loading dock — trench drain crossing
              </span>
              <span className="inline-flex items-center gap-1.5">
                <User className="w-3.5 h-3.5" strokeWidth={2} />
                Reported by Worker Rep
              </span>
              <span className="inline-flex items-center gap-1.5 tabular-nums">
                <Clock className="w-3.5 h-3.5" strokeWidth={2} />
                Updated 2h ago
              </span>
            </div>
          </div>

          {/* Section: Description */}
          <Section label="Description">
            <p className="text-sm text-slate-700 leading-relaxed">
              Operators of Raymond 8410 end-rider pallet trucks experience repeated whole-body vibration shocks
              when crossing the trench drain and dock leveler plate during the three-stage loading cycle.
              Four discrete shock events occur per cycle. Affected workers report lower-back pain and fatigue
              consistent with cumulative WBV exposure. Management's 2015 study (FJD Engineering Group) applied{' '}
              <Citation id="iso-2631-1" />, but never measured the trench drain and did not apply{' '}
              <Citation id="iso-2631-5" />, which is the appropriate standard for repeated multiple-shock exposure.
            </p>
          </Section>

          {/* Section: Statutory basis */}
          <Section label="Statutory basis">
            <div className="bg-slate-50 border border-slate-200 rounded-lg p-3.5 space-y-2.5">
              <CitationRow id="ohsa-s9-20" note="Worker JHSC right to issue written recommendations" />
              <CitationRow id="ohsa-s9-21" note="21-day response obligation for management" />
              <CitationRow id="oreg-851-s11" note="Powered lifting device operation safety" />
            </div>
          </Section>

          {/* Section: Linked recommendation */}
          <Section label="Linked recommendation" trailing={
            <button className="text-xs font-medium text-slate-500 hover:text-slate-900 flex items-center gap-0.5">
              View RC-002 <ChevronRight className="w-3 h-3" strokeWidth={2.5} />
            </button>
          }>
            <button className="w-full text-left bg-white border border-slate-200 rounded-lg p-3.5 hover:border-slate-300 transition-colors group">
              <div className="flex items-start gap-3">
                <span className="block w-1.5 h-1.5 rounded-full bg-blue-500 mt-1.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[11px] font-mono text-slate-500 tabular-nums">RC-002</span>
                    <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 uppercase tracking-wide">
                      Day 8 of 21
                    </span>
                  </div>
                  <div className="text-sm font-medium text-slate-900 mb-2">
                    Comprehensive WBV assessment under ISO 2631-1 / 2631-5
                  </div>
                  <div className="flex items-center justify-between gap-2 text-[11px] text-slate-500 mb-1 tabular-nums">
                    <span>Submitted May 4</span>
                    <span>13 days to response</span>
                  </div>
                  <div className="h-1 bg-slate-100 rounded-full overflow-hidden">
                    <div className="h-full bg-blue-500 rounded-full" style={{ width: '38%' }} />
                  </div>
                </div>
              </div>
            </button>
          </Section>

          {/* Section: Evidence */}
          <Section label="Evidence" count={6} trailing={
            <button className="text-xs font-medium text-slate-500 hover:text-slate-900 flex items-center gap-1">
              <Plus className="w-3 h-3" strokeWidth={2.5} />
              Add
            </button>
          }>
            <div className="grid grid-cols-3 gap-2">
              <EvidenceTile type="photo" label="Dock trench" gps />
              <EvidenceTile type="photo" label="Raymond 8410" gps />
              <EvidenceTile type="photo" label="Dock plate" gps />
              <EvidenceTile type="doc" label="FJD 2015 study" />
              <EvidenceTile type="audio" label="Operator note" />
              <EvidenceTile type="more" count={1} />
            </div>
          </Section>

          {/* Section: Witnesses */}
          <Section label="Witness statements" count={3} trailing={
            <button className="text-xs font-medium text-slate-500 hover:text-slate-900 flex items-center gap-1">
              <Plus className="w-3 h-3" strokeWidth={2.5} />
              Intake
            </button>
          }>
            <div className="space-y-2">
              <WitnessRow code="W-014" date="May 11" pseudonymous encrypted />
              <WitnessRow code="W-013" date="May 10" pseudonymous encrypted />
              <WitnessRow code="W-012" date="May 8" pseudonymous encrypted />
            </div>
          </Section>

          {/* Section: Activity */}
          <Section label="Activity">
            <div className="space-y-3">
              <ActivityRow
                icon={FileText}
                label="Recommendation RC-002 submitted to management"
                actor="Worker Co-Chair"
                time="May 4 · 9:42 AM"
                accent="blue"
              />
              <ActivityRow
                icon={MessageSquare}
                label="Witness statement W-014 added (encrypted)"
                actor="Worker Rep"
                time="May 11 · 2:18 PM"
              />
              <ActivityRow
                icon={ImageIcon}
                label="3 photos added with GPS metadata"
                actor="Worker Rep"
                time="May 5 · 11:03 AM"
              />
              <ActivityRow
                icon={AlertTriangle}
                label="Hazard created and assessed Critical"
                actor="Worker Co-Chair"
                time="May 4 · 8:15 AM"
              />
            </div>
          </Section>

          {/* Audit footer */}
          <button
            onClick={() => setShowAuditDrawer(true)}
            className="w-full mt-4 mb-2 bg-slate-50 border border-slate-200 rounded-lg p-3 flex items-center gap-3 hover:bg-slate-100 transition-colors text-left"
          >
            <div className="w-8 h-8 rounded-md bg-white border border-slate-200 flex items-center justify-center shrink-0">
              <Shield className="w-4 h-4 text-slate-600" strokeWidth={2} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-slate-900">Audit trail · 14 entries · chain verified</div>
              <div className="text-[11px] text-slate-500 font-mono tabular-nums truncate">
                hash f7d2a8…b3e1
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-slate-400" strokeWidth={2} />
          </button>
        </div>
      </div>

      {/* Audit drawer */}
      {showAuditDrawer && <AuditDrawer onClose={() => setShowAuditDrawer(false)} />}
    </div>
  );
}

// =================== Section wrapper ===================
function Section({ label, count, trailing, children }) {
  return (
    <section className="mb-6">
      <div className="flex items-baseline justify-between mb-2.5">
        <div className="flex items-baseline gap-2">
          <h2 className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">{label}</h2>
          {count !== undefined && (
            <span className="text-[11px] font-mono text-slate-400 tabular-nums">{count}</span>
          )}
        </div>
        {trailing}
      </div>
      {children}
    </section>
  );
}

// =================== Citation Hover (signature interaction) ===================
function Citation({ id }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const refEl = useRef(null);

  const entry = CORPUS[id];
  if (!entry) return null;

  const handleOpen = () => {
    if (refEl.current) {
      const rect = refEl.current.getBoundingClientRect();
      setPosition({
        top: rect.bottom + window.scrollY + 6,
        left: rect.left + window.scrollX,
      });
    }
    setOpen(true);
  };

  return (
    <>
      <button
        ref={refEl}
        onMouseEnter={handleOpen}
        onMouseLeave={() => setOpen(false)}
        onClick={handleOpen}
        className="inline-flex items-center gap-0.5 px-1.5 py-0.5 -my-0.5 rounded bg-slate-100 hover:bg-slate-200 text-slate-700 text-[12.5px] font-medium border border-slate-200 transition-colors align-baseline whitespace-nowrap"
      >
        {entry.statute} {entry.section}
      </button>
      {open && <CitationCard entry={entry} position={position} onClose={() => setOpen(false)} />}
    </>
  );
}

function CitationCard({ entry, position, onClose }) {
  // Position adjustments to keep within viewport
  const adjustedLeft = typeof window !== 'undefined'
    ? Math.min(position.left, window.innerWidth - 380)
    : position.left;

  return (
    <div
      className="absolute z-50 w-[360px] bg-white border border-slate-200 rounded-lg shadow-xl shadow-slate-900/10 overflow-hidden animate-in fade-in slide-in-from-top-1 duration-100"
      style={{ top: position.top, left: Math.max(16, adjustedLeft) }}
      onMouseEnter={() => {}}
      onMouseLeave={onClose}
    >
      <div className="px-4 py-3 border-b border-slate-200 bg-slate-50">
        <div className="flex items-center justify-between gap-2 mb-1">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">{entry.statute}</span>
            <span className="text-[11px] font-mono text-slate-400 tabular-nums">{entry.section}</span>
          </div>
          <span className="text-[10px] font-mono text-slate-400 tabular-nums">{entry.versionDate}</span>
        </div>
        <div className="text-sm font-medium text-slate-900 leading-tight">{entry.title}</div>
      </div>
      <div className="px-4 py-3" style={{ fontFamily: 'Source Serif 4, Georgia, serif' }}>
        <p className="text-[13.5px] text-slate-700 leading-relaxed">
          {entry.summary}
        </p>
      </div>
      <div className="px-4 py-2.5 bg-slate-50 border-t border-slate-200 flex items-center justify-between gap-2">
        <a
          href={entry.sourceUrl}
          className="text-[11px] font-medium text-slate-600 hover:text-slate-900 inline-flex items-center gap-1"
        >
          <BookOpen className="w-3 h-3" strokeWidth={2} />
          Official source
          <ExternalLink className="w-2.5 h-2.5" strokeWidth={2} />
        </a>
        <button className="text-[11px] font-medium text-slate-900 inline-flex items-center gap-1 hover:underline">
          <Quote className="w-3 h-3" strokeWidth={2} />
          Insert into draft
        </button>
      </div>
      <div className="px-4 py-2 bg-slate-50 border-t border-slate-200 flex items-center gap-1.5">
        <Hash className="w-3 h-3 text-slate-400" strokeWidth={2} />
        <span className="text-[10px] font-mono text-slate-400 tabular-nums">corpus.{entry.hash}</span>
      </div>
    </div>
  );
}

// =================== Citation row (for statutory basis section) ===================
function CitationRow({ id, note }) {
  const entry = CORPUS[id];
  if (!entry) return null;
  return (
    <div className="flex items-start gap-3">
      <Citation id={id} />
      <span className="text-xs text-slate-600 leading-relaxed pt-0.5">{note}</span>
    </div>
  );
}

// =================== Evidence tile ===================
function EvidenceTile({ type, label, count, gps }) {
  if (type === 'more') {
    return (
      <button className="aspect-square rounded-lg border border-dashed border-slate-300 flex flex-col items-center justify-center text-slate-500 hover:text-slate-900 hover:border-slate-400 transition-colors">
        <span className="text-lg font-semibold tabular-nums">+{count}</span>
        <span className="text-[10px] uppercase tracking-wide font-medium">more</span>
      </button>
    );
  }

  const Icon = type === 'photo' ? Camera : type === 'audio' ? Mic : FileText;
  const tileBg = type === 'photo'
    ? 'bg-gradient-to-br from-slate-700 to-slate-900'
    : type === 'audio'
    ? 'bg-gradient-to-br from-blue-700 to-blue-900'
    : 'bg-gradient-to-br from-amber-700 to-amber-900';

  return (
    <button className="group relative aspect-square rounded-lg overflow-hidden border border-slate-200 hover:border-slate-300 transition-colors">
      <div className={`absolute inset-0 ${tileBg}`}>
        <div className="absolute inset-0 flex items-center justify-center">
          <Icon className="w-7 h-7 text-white/40" strokeWidth={1.5} />
        </div>
      </div>
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-1.5">
        <div className="flex items-center gap-1">
          {gps && <MapPin className="w-2.5 h-2.5 text-white/70" strokeWidth={2.5} />}
          <span className="text-[10px] font-medium text-white truncate">{label}</span>
        </div>
      </div>
      <div className="absolute top-1.5 right-1.5">
        <div className="w-4 h-4 rounded bg-black/40 backdrop-blur flex items-center justify-center">
          <Lock className="w-2.5 h-2.5 text-white/90" strokeWidth={2.5} />
        </div>
      </div>
    </button>
  );
}

// =================== Witness row ===================
function WitnessRow({ code, date, pseudonymous, encrypted }) {
  return (
    <button className="w-full flex items-center gap-3 p-2.5 bg-white border border-slate-200 rounded-lg hover:border-slate-300 transition-colors text-left group">
      <div className="w-8 h-8 rounded-md bg-slate-100 flex items-center justify-center shrink-0">
        <User className="w-4 h-4 text-slate-500" strokeWidth={2} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 mb-0.5">
          <span className="text-xs font-mono text-slate-700 tabular-nums font-medium">{code}</span>
          {pseudonymous && (
            <span className="text-[9px] font-medium px-1 py-px rounded bg-slate-100 text-slate-500 uppercase tracking-wide">
              Pseudo
            </span>
          )}
          {encrypted && (
            <Lock className="w-2.5 h-2.5 text-slate-400" strokeWidth={2.5} />
          )}
        </div>
        <div className="text-[11px] text-slate-500 tabular-nums">Statement filed {date}</div>
      </div>
      <ChevronRight className="w-4 h-4 text-slate-300 group-hover:text-slate-500 transition-colors" strokeWidth={2} />
    </button>
  );
}

// =================== Activity row ===================
function ActivityRow({ icon: Icon, label, actor, time, accent }) {
  const accentColor = accent === 'blue' ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-600';
  return (
    <div className="flex items-start gap-3">
      <div className={`w-7 h-7 rounded-md ${accentColor} flex items-center justify-center shrink-0 mt-0.5`}>
        <Icon className="w-3.5 h-3.5" strokeWidth={2} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm text-slate-900 leading-snug">{label}</div>
        <div className="text-[11px] text-slate-500 mt-0.5 tabular-nums">
          <span>{actor}</span>
          <span className="mx-1.5 text-slate-300">·</span>
          <span>{time}</span>
        </div>
      </div>
    </div>
  );
}

// =================== Audit drawer ===================
function AuditDrawer({ onClose }) {
  const entries = [
    { action: 'witness_statement.add', actor: 'Worker Rep', time: 'May 11 · 2:18 PM', hash: 'a2b8...91d4' },
    { action: 'evidence.upload', actor: 'Worker Rep', time: 'May 8 · 3:41 PM', hash: 'f7d2...b3e1' },
    { action: 'recommendation.link', actor: 'Worker Co-Chair', time: 'May 4 · 9:42 AM', hash: 'c1e7...a8f2' },
    { action: 'evidence.upload', actor: 'Worker Rep', time: 'May 5 · 11:03 AM', hash: 'b9d4...f2e6' },
    { action: 'hazard.assess', actor: 'Worker Co-Chair', time: 'May 4 · 8:15 AM', hash: '3e8c...d1b7' },
    { action: 'hazard.create', actor: 'Worker Rep', time: 'May 4 · 7:58 AM', hash: '0000...0001' },
  ];

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-sm flex items-end lg:items-stretch lg:justify-end animate-in fade-in duration-100"
      onClick={onClose}
    >
      <div
        className="w-full lg:w-[420px] bg-white lg:border-l border-slate-200 rounded-t-2xl lg:rounded-none animate-in slide-in-from-bottom lg:slide-in-from-right duration-200 flex flex-col max-h-[85vh] lg:max-h-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-center pt-3 lg:hidden">
          <div className="w-10 h-1 rounded-full bg-slate-200" />
        </div>
        <div className="px-5 py-4 border-b border-slate-200 flex items-start justify-between gap-3">
          <div>
            <div className="text-base font-semibold text-slate-900">Audit trail</div>
            <div className="text-xs text-slate-500 mt-0.5 tabular-nums">14 entries · chain verified just now</div>
          </div>
          <button onClick={onClose} className="h-8 w-8 -mr-2 rounded-md hover:bg-slate-100 flex items-center justify-center">
            <X className="w-4 h-4 text-slate-500" strokeWidth={2} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">
          <div className="mb-4 p-3 bg-emerald-50 border border-emerald-100 rounded-lg flex items-start gap-2.5">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 mt-0.5 shrink-0" strokeWidth={2.25} />
            <div className="text-xs text-emerald-900">
              <div className="font-medium mb-0.5">Hash chain verified</div>
              <div className="text-emerald-800/80">All 14 entries cryptographically linked. No tampering detected.</div>
            </div>
          </div>

          <div className="space-y-3">
            {entries.map((entry, i) => (
              <div key={i} className="flex items-start gap-3 pb-3 border-b border-slate-100 last:border-0">
                <div className="w-1.5 h-1.5 rounded-full bg-slate-300 mt-1.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-mono text-slate-900 mb-0.5">{entry.action}</div>
                  <div className="text-[11px] text-slate-500 tabular-nums">
                    {entry.actor} · {entry.time}
                  </div>
                  <div className="text-[10px] font-mono text-slate-400 mt-1 tabular-nums">
                    sha256 {entry.hash}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="px-5 py-3 border-t border-slate-200 flex items-center justify-between gap-2">
          <button className="text-xs font-medium text-slate-600 hover:text-slate-900 inline-flex items-center gap-1.5">
            <Download className="w-3.5 h-3.5" strokeWidth={2} />
            Export chain
          </button>
          <span className="text-[10px] font-mono text-slate-400">XChaCha20-Poly1305</span>
        </div>
      </div>
    </div>
  );
}
