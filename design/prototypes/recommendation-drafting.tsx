import React, { useState, useEffect, useRef } from 'react';
import {
  ArrowLeft,
  X,
  ChevronRight,
  ChevronDown,
  MoreHorizontal,
  Hash,
  ExternalLink,
  Plus,
  Clock,
  Calendar,
  Shield,
  Quote,
  BookOpen,
  AlertCircle,
  CheckCircle2,
  Circle,
  Search,
  FileText,
  Sparkles,
  Send,
  Save,
  Eye,
  Download,
  Lock,
  ChevronUp,
  Bold,
  Italic,
  List,
  Link2,
  Type,
  ScrollText,
} from 'lucide-react';

// =================== Mock corpus ===================
const CORPUS = {
  'ohsa-s9-20': { statute: 'OHSA', section: 's. 9(20)', title: 'Recommendations of committee', summary: 'A joint health and safety committee may make written recommendations to the constructor or employer for the improvement of the health and safety of workers and shall respond in writing within twenty-one days.', versionDate: '2023-06-08', sourceUrl: 'https://www.ontario.ca/laws/statute/90o01', hash: 'a3f4e2c1' },
  'ohsa-s9-21': { statute: 'OHSA', section: 's. 9(21)', title: 'Response to recommendations', summary: 'The constructor or employer shall respond to written recommendations within twenty-one days. The response shall contain a timetable for implementing recommendations the constructor or employer agrees with and give reasons for disagreement with any recommendation not accepted.', versionDate: '2023-06-08', sourceUrl: 'https://www.ontario.ca/laws/statute/90o01', hash: '7b21d9f4' },
  'ohsa-s25-2-h': { statute: 'OHSA', section: 's. 25(2)(h)', title: 'Duty to take precautions', summary: 'An employer shall take every precaution reasonable in the circumstances for the protection of a worker.', versionDate: '2023-06-08', sourceUrl: 'https://www.ontario.ca/laws/statute/90o01', hash: 'd8e2a17c' },
  'oreg-851-s21': { statute: 'O. Reg. 851', section: 's. 21', title: 'Materials handling', summary: 'Materials, articles or things shall be transported, placed or stored so that they will not tip, collapse or fall, and can be removed or withdrawn without endangering a worker.', versionDate: '2023-06-08', sourceUrl: 'https://www.ontario.ca/laws/regulation/900851', hash: 'b4f1d2e3' },
  'iso-2631-1': { statute: 'ISO 2631-1', section: '1997', title: 'Whole-body vibration — General requirements', summary: 'Defines methods for measuring periodic, random and transient whole-body vibration. Establishes Exposure Action Value (EAV) of 0.5 m/s² and Exposure Limit Value (ELV) of 1.15 m/s² over 8 hours.', versionDate: '1997', sourceUrl: 'https://www.iso.org/standard/7612.html', hash: 'iso2631-1' },
  'iso-2631-5': { statute: 'ISO 2631-5', section: '2018', title: 'WBV — Multiple shocks', summary: 'Provides methods for evaluating health effects of whole-body vibration containing multiple shocks, relevant to operations involving repeated impacts such as crossing trench drains or dock plates.', versionDate: '2018', sourceUrl: 'https://www.iso.org/standard/50905.html', hash: 'iso2631-5' },
  'acgih-tlv': { statute: 'ACGIH TLV', section: 'WBV 2024', title: 'Whole-body vibration threshold limit value', summary: 'Recommends action levels and exposure limits for whole-body vibration based on health effects research. Used as a Canadian reference threshold under MSD Prevention Guideline.', versionDate: '2024', sourceUrl: 'https://www.acgih.org/', hash: 'acgih-wbv' },
};

export default function RecommendationDrafting() {
  const [isDesktop, setIsDesktop] = useState(false);
  const [showAdversarialPanel, setShowAdversarialPanel] = useState(false);
  const [showCitationPicker, setShowCitationPicker] = useState(false);
  const [showPreview, setShowPreview] = useState(false);

  useEffect(() => {
    const check = () => setIsDesktop(window.innerWidth >= 1024);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 antialiased" style={{ fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, system-ui, sans-serif' }}>
      <div className="flex flex-col min-h-screen">
        {/* Header */}
        <header className="sticky top-0 z-20 bg-white/95 backdrop-blur border-b border-slate-200">
          <div className="px-4 lg:px-6 py-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <button className="h-9 w-9 -ml-2 rounded-lg hover:bg-slate-100 flex items-center justify-center text-slate-700">
                <ArrowLeft className="w-5 h-5" strokeWidth={2} />
              </button>
              <div className="min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="text-[11px] font-mono text-slate-500 tabular-nums">RC-002</span>
                  <span className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-100 uppercase tracking-wide">
                    Day 8 of 21
                  </span>
                  <span className="hidden sm:inline-flex items-center gap-1 text-[10px] text-slate-500">
                    <Save className="w-3 h-3" strokeWidth={2} />
                    Saved 4s ago
                  </span>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button
                onClick={() => setShowAdversarialPanel(true)}
                className="hidden sm:inline-flex h-9 px-3 rounded-md bg-slate-900 text-white text-xs font-medium hover:bg-slate-800 items-center gap-1.5"
              >
                <Sparkles className="w-3.5 h-3.5" strokeWidth={2} />
                Adversarial Lens
              </button>
              <button
                onClick={() => setShowPreview(true)}
                className="h-9 px-3 rounded-md border border-slate-200 text-xs font-medium text-slate-700 hover:border-slate-300 hover:bg-slate-50 hidden sm:inline-flex items-center gap-1.5"
              >
                <Eye className="w-3.5 h-3.5" strokeWidth={2} />
                Preview
              </button>
              <button className="h-9 w-9 rounded-md hover:bg-slate-100 flex items-center justify-center text-slate-600">
                <MoreHorizontal className="w-[18px] h-[18px]" strokeWidth={2} />
              </button>
            </div>
          </div>

          {/* 21-day clock strip */}
          <div className="px-4 lg:px-6 pb-3">
            <div className="flex items-center gap-3">
              <div className="flex-1">
                <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                  <div className="h-full bg-blue-500 rounded-full transition-all" style={{ width: '38%' }} />
                </div>
              </div>
              <div className="text-[11px] tabular-nums text-slate-600 shrink-0">
                <span className="font-medium text-slate-900">13 days</span>
                <span className="text-slate-500"> to s. 9(21) response</span>
              </div>
            </div>
          </div>
        </header>

        <div className="flex-1 flex">
          {/* Main editor */}
          <div className="flex-1 overflow-y-auto">
            <div className="max-w-3xl mx-auto px-4 lg:px-8 py-6 lg:py-10 pb-32">
              {/* Title input (looks like a title, acts like an input) */}
              <div className="mb-1">
                <div className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Title</div>
                <div className="text-xl lg:text-2xl font-semibold tracking-tight text-slate-900 leading-tight border-b border-slate-100 pb-3 mb-6 outline-none focus:border-slate-300 transition-colors" contentEditable suppressContentEditableWarning>
                  Recommendation for a comprehensive whole-body vibration assessment under ISO 2631-1 and ISO 2631-5
                </div>
              </div>

              {/* Metadata strip */}
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-slate-600 mb-8 pb-6 border-b border-slate-100">
                <MetaField label="Submitted" value="May 4, 2026" />
                <MetaField label="Response due" value="May 25, 2026" />
                <MetaField label="Recipient" value="Management Co-Chair" />
                <MetaField label="Linked hazard" value="H-047" mono />
              </div>

              {/* Sections */}
              <Section number="1" title="Statutory authority">
                <p className="text-[15px] text-slate-700 leading-relaxed">
                  The worker members of the Joint Health and Safety Committee make this written recommendation
                  pursuant to <Citation id="ohsa-s9-20" />. Management's response is required within twenty-one
                  days under <Citation id="ohsa-s9-21" />, including a timetable for any recommendations accepted
                  and written reasons for any not accepted.
                </p>
              </Section>

              <Section number="2" title="Hazard identified">
                <p className="text-[15px] text-slate-700 leading-relaxed mb-3">
                  Operators of the powered lifting devices at the loading dock are exposed to whole-body
                  vibration (WBV) and repeated mechanical shock during routine operations. The hazard manifests
                  in a three-stage operator cycle where the device crosses a trench drain and dock leveler
                  plate, producing four discrete shock events per cycle.
                </p>
                <p className="text-[15px] text-slate-700 leading-relaxed">
                  Affected workers report lower-back pain and fatigue consistent with cumulative WBV exposure.
                  The employer's duty to take every precaution reasonable in the circumstances is engaged under{' '}
                  <Citation id="ohsa-s25-2-h" />, and the materials-handling requirements under{' '}
                  <Citation id="oreg-851-s21" /> apply to the operational context.
                </p>
              </Section>

              <Section number="3" title="Assessment standards">
                <p className="text-[15px] text-slate-700 leading-relaxed mb-3">
                  A defensible WBV assessment in this context requires all three of the following standards
                  applied together:
                </p>
                <ul className="space-y-2 text-[15px] text-slate-700 leading-relaxed pl-5">
                  <li className="list-disc">
                    <Citation id="iso-2631-1" /> — for time-averaged vibration exposure measurement.
                  </li>
                  <li className="list-disc">
                    <Citation id="iso-2631-5" /> — for evaluation of repeated multiple-shock exposure, which
                    is the operative standard for the trench drain and dock plate crossings.
                  </li>
                  <li className="list-disc">
                    <Citation id="acgih-tlv" /> — as a Canadian reference threshold under the MSD Prevention
                    Guideline.
                  </li>
                </ul>
              </Section>

              <Section number="4" title="What the recommendation requires" empty>
                <button className="w-full py-6 border border-dashed border-slate-300 rounded-lg text-sm text-slate-500 hover:border-slate-400 hover:text-slate-700 transition-colors flex items-center justify-center gap-2">
                  <Plus className="w-4 h-4" strokeWidth={2} />
                  Add the operative requirements
                </button>
              </Section>

              {/* Toolbar (sticky at bottom of content area on desktop, floating on mobile) */}
              <div className="mt-12 hidden lg:flex items-center gap-1 sticky bottom-6 mx-auto w-fit bg-white border border-slate-200 rounded-full shadow-lg shadow-slate-900/10 px-2 py-1">
                <ToolbarBtn icon={Type} label="Heading" />
                <ToolbarBtn icon={Bold} label="Bold" />
                <ToolbarBtn icon={Italic} label="Italic" />
                <ToolbarBtn icon={List} label="List" />
                <ToolbarBtn icon={Quote} label="Quote" />
                <div className="h-5 w-px bg-slate-200 mx-1" />
                <ToolbarBtn icon={BookOpen} label="Citation" primary onClick={() => setShowCitationPicker(true)} />
                <ToolbarBtn icon={Link2} label="Link hazard" />
              </div>
            </div>
          </div>

          {/* Right rail (desktop only) */}
          {isDesktop && (
            <aside className="w-[320px] border-l border-slate-200 bg-white overflow-y-auto">
              <div className="p-5 space-y-6">
                <RailSection label="Status">
                  <StatusStepper />
                </RailSection>

                <RailSection label="Linked hazard">
                  <button className="w-full text-left bg-slate-50 border border-slate-200 rounded-lg p-3 hover:bg-slate-100 transition-colors">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="block w-1.5 h-1.5 rounded-full bg-red-500" />
                      <span className="text-[11px] font-mono text-slate-500 tabular-nums">H-047</span>
                    </div>
                    <div className="text-xs font-medium text-slate-900 leading-snug">
                      WBV exposure — dock cycle
                    </div>
                    <div className="text-[11px] text-slate-500 mt-1">Critical · Open 12d</div>
                  </button>
                </RailSection>

                <RailSection label="Citations used" count={6}>
                  <div className="space-y-1.5">
                    <CitationListItem id="ohsa-s9-20" count={1} />
                    <CitationListItem id="ohsa-s9-21" count={1} />
                    <CitationListItem id="ohsa-s25-2-h" count={1} />
                    <CitationListItem id="oreg-851-s21" count={1} />
                    <CitationListItem id="iso-2631-1" count={1} />
                    <CitationListItem id="iso-2631-5" count={1} />
                    <CitationListItem id="acgih-tlv" count={1} />
                  </div>
                </RailSection>

                <RailSection label="Outline">
                  <div className="space-y-px">
                    <OutlineItem n="1" label="Statutory authority" complete />
                    <OutlineItem n="2" label="Hazard identified" complete />
                    <OutlineItem n="3" label="Assessment standards" complete />
                    <OutlineItem n="4" label="What the recommendation requires" />
                    <OutlineItem n="5" label="Response deadline" />
                  </div>
                </RailSection>

                <RailSection label="Provenance">
                  <div className="text-[11px] font-mono text-slate-500 tabular-nums space-y-1">
                    <div className="flex items-center gap-1.5">
                      <Hash className="w-3 h-3 text-slate-400" strokeWidth={2} />
                      doc.7b21d9f4...e3a8
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Lock className="w-3 h-3 text-slate-400" strokeWidth={2} />
                      Audit chain entry 14
                    </div>
                  </div>
                </RailSection>
              </div>
            </aside>
          )}
        </div>

        {/* Mobile bottom action bar */}
        <div className="lg:hidden fixed bottom-0 left-0 right-0 bg-white border-t border-slate-200 px-4 py-3 z-10" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 12px)' }}>
          <div className="flex items-center gap-2">
            <button onClick={() => setShowCitationPicker(true)} className="h-10 w-10 rounded-md border border-slate-200 flex items-center justify-center text-slate-700 active:bg-slate-50">
              <BookOpen className="w-4 h-4" strokeWidth={2} />
            </button>
            <button onClick={() => setShowAdversarialPanel(true)} className="h-10 px-3 rounded-md bg-slate-900 text-white text-xs font-medium flex items-center gap-1.5 active:bg-slate-800">
              <Sparkles className="w-3.5 h-3.5" strokeWidth={2} />
              Adversarial
            </button>
            <button onClick={() => setShowPreview(true)} className="h-10 px-3 rounded-md border border-slate-200 text-xs font-medium text-slate-700 flex items-center gap-1.5 active:bg-slate-50">
              <Eye className="w-3.5 h-3.5" strokeWidth={2} />
              Preview
            </button>
            <button className="ml-auto h-10 px-4 rounded-md bg-blue-600 text-white text-xs font-medium flex items-center gap-1.5 active:bg-blue-700">
              <Send className="w-3.5 h-3.5" strokeWidth={2} />
              Submit
            </button>
          </div>
        </div>
      </div>

      {showCitationPicker && <CitationPicker onClose={() => setShowCitationPicker(false)} />}
      {showAdversarialPanel && <AdversarialPanel onClose={() => setShowAdversarialPanel(false)} />}
      {showPreview && <PreviewModal onClose={() => setShowPreview(false)} />}
    </div>
  );
}

// =================== Components ===================

function Section({ number, title, empty, children }) {
  return (
    <section className="mb-8">
      <div className="flex items-baseline gap-3 mb-3">
        <span className="text-[11px] font-mono text-slate-400 tabular-nums">{number}</span>
        <h2 className="text-base font-semibold text-slate-900 tracking-tight">{title}</h2>
      </div>
      {children}
    </section>
  );
}

function MetaField({ label, value, mono }) {
  return (
    <div>
      <div className="text-[10px] font-medium uppercase tracking-wide text-slate-400 mb-0.5">{label}</div>
      <div className={`text-sm text-slate-900 ${mono ? 'font-mono tabular-nums' : ''}`}>{value}</div>
    </div>
  );
}

function ToolbarBtn({ icon: Icon, label, primary, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`h-8 px-2 rounded-full flex items-center gap-1.5 text-xs font-medium transition-colors ${
        primary
          ? 'bg-slate-900 text-white hover:bg-slate-800'
          : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
      }`}
      title={label}
    >
      <Icon className="w-3.5 h-3.5" strokeWidth={2} />
      <span className="hidden xl:inline">{label}</span>
    </button>
  );
}

function RailSection({ label, count, children }) {
  return (
    <div>
      <div className="flex items-baseline gap-2 mb-2">
        <h3 className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">{label}</h3>
        {count !== undefined && (
          <span className="text-[11px] font-mono text-slate-400 tabular-nums">{count}</span>
        )}
      </div>
      {children}
    </div>
  );
}

function StatusStepper() {
  const steps = [
    { label: 'Drafting', state: 'done' },
    { label: 'Submitted', state: 'current' },
    { label: 'Response received', state: 'pending' },
    { label: 'Closed', state: 'pending' },
  ];
  return (
    <div className="space-y-1.5">
      {steps.map((step, i) => (
        <div key={i} className="flex items-center gap-2.5">
          {step.state === 'done' && <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" strokeWidth={2.25} />}
          {step.state === 'current' && (
            <div className="w-4 h-4 rounded-full border-2 border-blue-500 bg-blue-50 flex items-center justify-center shrink-0">
              <span className="block w-1.5 h-1.5 rounded-full bg-blue-500" />
            </div>
          )}
          {step.state === 'pending' && <Circle className="w-4 h-4 text-slate-300 shrink-0" strokeWidth={2} />}
          <span className={`text-sm ${step.state === 'current' ? 'text-slate-900 font-medium' : step.state === 'done' ? 'text-slate-700' : 'text-slate-400'}`}>
            {step.label}
          </span>
        </div>
      ))}
    </div>
  );
}

function CitationListItem({ id, count }) {
  const entry = CORPUS[id];
  if (!entry) return null;
  return (
    <button className="w-full flex items-center gap-2 px-2 py-1.5 -mx-2 rounded hover:bg-slate-50 transition-colors text-left">
      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium text-slate-900">{entry.statute} <span className="font-mono tabular-nums text-slate-600">{entry.section}</span></div>
        <div className="text-[10px] text-slate-500 truncate">{entry.title}</div>
      </div>
      <span className="text-[10px] font-mono text-slate-400 tabular-nums shrink-0">×{count}</span>
    </button>
  );
}

function OutlineItem({ n, label, complete }) {
  return (
    <button className="w-full flex items-center gap-2 px-2 py-1.5 -mx-2 rounded hover:bg-slate-50 transition-colors text-left">
      <span className={`text-[10px] font-mono tabular-nums shrink-0 ${complete ? 'text-emerald-600' : 'text-slate-400'}`}>{n}</span>
      <span className={`text-xs flex-1 truncate ${complete ? 'text-slate-700' : 'text-slate-500'}`}>{label}</span>
      {complete && <CheckCircle2 className="w-3 h-3 text-emerald-500 shrink-0" strokeWidth={2.25} />}
    </button>
  );
}

// =================== Citation Hover (same primitive as before) ===================
function Citation({ id }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const refEl = useRef(null);
  const entry = CORPUS[id];
  if (!entry) return null;

  const handleOpen = () => {
    if (refEl.current) {
      const rect = refEl.current.getBoundingClientRect();
      setPosition({ top: rect.bottom + window.scrollY + 6, left: rect.left + window.scrollX });
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
      {open && (
        <div
          className="absolute z-50 w-[360px] bg-white border border-slate-200 rounded-lg shadow-xl shadow-slate-900/10 overflow-hidden animate-in fade-in slide-in-from-top-1 duration-100"
          style={{ top: position.top, left: Math.min(position.left, typeof window !== 'undefined' ? window.innerWidth - 380 : 0) }}
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
            <p className="text-[13.5px] text-slate-700 leading-relaxed">{entry.summary}</p>
          </div>
          <div className="px-4 py-2.5 bg-slate-50 border-t border-slate-200 flex items-center justify-between gap-2">
            <a className="text-[11px] font-medium text-slate-600 hover:text-slate-900 inline-flex items-center gap-1">
              <BookOpen className="w-3 h-3" strokeWidth={2} /> Official source <ExternalLink className="w-2.5 h-2.5" strokeWidth={2} />
            </a>
            <button className="text-[11px] font-medium text-slate-900 inline-flex items-center gap-1 hover:underline">
              <Quote className="w-3 h-3" strokeWidth={2} /> Insert into draft
            </button>
          </div>
        </div>
      )}
    </>
  );
}

// =================== Citation picker ===================
function CitationPicker({ onClose }) {
  const [query, setQuery] = useState('');
  const all = Object.entries(CORPUS);
  const filtered = all.filter(([id, e]) =>
    e.statute.toLowerCase().includes(query.toLowerCase()) ||
    e.title.toLowerCase().includes(query.toLowerCase()) ||
    e.section.toLowerCase().includes(query.toLowerCase())
  );

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-sm flex items-end lg:items-start lg:justify-center lg:pt-[12vh]" onClick={onClose}>
      <div className="w-full lg:max-w-xl bg-white lg:mx-4 rounded-t-2xl lg:rounded-xl border-t lg:border border-slate-200 overflow-hidden animate-in slide-in-from-bottom lg:zoom-in-95 duration-200 flex flex-col" style={{ maxHeight: '85vh', paddingBottom: 'env(safe-area-inset-bottom)' }} onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-center pt-3 lg:hidden"><div className="w-10 h-1 rounded-full bg-slate-200" /></div>
        <div className="px-4 py-3 lg:px-5 lg:py-4 border-b border-slate-200">
          <div className="flex items-center justify-between mb-3">
            <div>
              <div className="text-base font-semibold">Insert citation</div>
              <div className="text-xs text-slate-500">From the verified legal corpus</div>
            </div>
            <button onClick={onClose} className="h-8 w-8 -mr-2 rounded-md hover:bg-slate-100 flex items-center justify-center">
              <X className="w-4 h-4 text-slate-500" strokeWidth={2} />
            </button>
          </div>
          <div className="flex items-center gap-2 h-10 px-3 rounded-md border border-slate-200 bg-slate-50">
            <Search className="w-4 h-4 text-slate-400" strokeWidth={2} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="OHSA, ISO, ACGIH, section…" className="flex-1 bg-transparent outline-none text-sm placeholder:text-slate-400" autoFocus />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto py-2">
          {filtered.map(([id, entry]) => (
            <button key={id} className="w-full text-left px-4 lg:px-5 py-2.5 hover:bg-slate-50 transition-colors group">
              <div className="flex items-center gap-2 mb-0.5">
                <span className="text-xs font-semibold text-slate-700 uppercase tracking-wide">{entry.statute}</span>
                <span className="text-xs font-mono text-slate-500 tabular-nums">{entry.section}</span>
              </div>
              <div className="text-sm text-slate-900 mb-0.5">{entry.title}</div>
              <div className="text-xs text-slate-500 truncate">{entry.summary.slice(0, 110)}…</div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// =================== Adversarial Lens panel (preview placeholder; full screen in next prototype) ===================
function AdversarialPanel({ onClose }) {
  return (
    <div className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-sm flex items-end lg:items-stretch lg:justify-end" onClick={onClose}>
      <div className="w-full lg:w-[460px] bg-white lg:border-l border-slate-200 rounded-t-2xl lg:rounded-none animate-in slide-in-from-bottom lg:slide-in-from-right duration-200 flex flex-col max-h-[85vh] lg:max-h-none" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }} onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-center pt-3 lg:hidden"><div className="w-10 h-1 rounded-full bg-slate-200" /></div>
        <div className="px-5 py-4 border-b border-slate-200 flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <Sparkles className="w-4 h-4 text-slate-900" strokeWidth={2} />
              <div className="text-base font-semibold">Adversarial Lens</div>
            </div>
            <div className="text-xs text-slate-500">How will management likely respond?</div>
          </div>
          <button onClick={onClose} className="h-8 w-8 -mr-2 rounded-md hover:bg-slate-100 flex items-center justify-center">
            <X className="w-4 h-4 text-slate-500" strokeWidth={2} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">
          <div className="text-xs text-slate-500 mb-4 leading-relaxed">
            Based on pattern data and your recommendation's content, the three most likely management responses,
            with rebuttal scaffolds ready to deploy.
          </div>
          <div className="space-y-4">
            <Counter rank={1} likelihood="High" headline="“We already conducted a WBV study in 2015.”" rebuttal="The 2015 FJD Engineering study is in draft form, applied only ISO 2631-1, never measured the trench drain, and is now eleven years out of date. The current recommendation requires application of ISO 2631-5 (multi-shock) which the 2015 study did not consider." />
            <Counter rank={2} likelihood="Medium" headline="“We will conduct an internal assessment instead of hiring an external assessor.”" rebuttal="Internal assessment is acceptable only if conducted by a person qualified to apply ISO 2631-5. The recommendation specifies ROH/CIH/CPE qualification because the multi-shock evaluation method requires documented competency. Workers may refuse an internal assessment that does not meet this bar." />
            <Counter rank={3} likelihood="Medium" headline="“The hazard is not unmitigated; an SWP exists.”" rebuttal="The Safe Work Procedure has not been finalized. JHSC minutes from March 26 confirm the SWP is still in development and that staffing levels on PM and midnight shifts prevent consistent use of the counterbalance forklift alternative. The s. 25(2)(h) duty is not satisfied by a draft procedure." />
          </div>
        </div>
        <div className="px-5 py-3 border-t border-slate-200 text-[11px] text-slate-500 flex items-center justify-between">
          <span>Predictions improve as outcomes are recorded</span>
          <Lock className="w-3 h-3" strokeWidth={2} />
        </div>
      </div>
    </div>
  );
}

function Counter({ rank, likelihood, headline, rebuttal }) {
  const tone = likelihood === 'High' ? 'bg-red-50 text-red-700 border-red-100' : 'bg-amber-50 text-amber-700 border-amber-100';
  return (
    <div className="border border-slate-200 rounded-lg overflow-hidden">
      <div className="px-3.5 py-2.5 bg-slate-50 border-b border-slate-200 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-mono text-slate-500 tabular-nums">#{rank}</span>
          <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded border ${tone} uppercase tracking-wide`}>
            {likelihood} likelihood
          </span>
        </div>
      </div>
      <div className="px-3.5 py-3" style={{ fontFamily: 'Source Serif 4, Georgia, serif' }}>
        <div className="text-sm text-slate-900 italic mb-2 leading-snug">{headline}</div>
        <div className="text-[13px] text-slate-700 leading-relaxed">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 mr-1 not-italic" style={{ fontFamily: 'Inter, sans-serif' }}>Rebuttal:</span>
          {rebuttal}
        </div>
      </div>
    </div>
  );
}

// =================== Preview modal ===================
function PreviewModal({ onClose }) {
  return (
    <div className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center p-4 lg:p-10" onClick={onClose}>
      <div className="w-full max-w-2xl bg-white rounded-xl border border-slate-200 overflow-hidden shadow-2xl flex flex-col max-h-[90vh]" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-slate-200 flex items-center justify-between bg-slate-50">
          <div className="flex items-center gap-2">
            <ScrollText className="w-4 h-4 text-slate-600" strokeWidth={2} />
            <div className="text-sm font-semibold">Print preview · RC-002</div>
          </div>
          <div className="flex items-center gap-1">
            <button className="h-8 px-2 rounded-md text-xs font-medium text-slate-600 hover:bg-slate-100 inline-flex items-center gap-1">
              <Download className="w-3.5 h-3.5" strokeWidth={2} /> PDF
            </button>
            <button onClick={onClose} className="h-8 w-8 rounded-md hover:bg-slate-100 flex items-center justify-center">
              <X className="w-4 h-4 text-slate-500" strokeWidth={2} />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto bg-slate-100 p-6">
          <div className="bg-white shadow-md mx-auto" style={{ maxWidth: '600px', fontFamily: 'Source Serif 4, Georgia, serif' }}>
            <div className="p-10">
              <div className="text-[10px] font-sans uppercase tracking-widest text-slate-500 mb-1">Recommendation under Occupational Health and Safety Act s. 9(20)</div>
              <div className="text-[10px] font-mono text-slate-500 tabular-nums mb-6">RC-002 · Submitted May 4, 2026</div>
              <h1 className="text-xl text-slate-900 leading-snug mb-6 font-semibold">
                Recommendation for a comprehensive whole-body vibration assessment under ISO 2631-1 and ISO 2631-5
              </h1>
              <div className="text-sm text-slate-800 leading-relaxed space-y-3">
                <p><strong className="font-semibold">1. Statutory authority.</strong> The worker members of the Joint Health and Safety Committee make this written recommendation pursuant to <em>OHSA s. 9(20)</em>. Management's response is required within twenty-one days under <em>OHSA s. 9(21)</em>.</p>
                <p><strong className="font-semibold">2. Hazard identified.</strong> Operators of the powered lifting devices at the loading dock are exposed to whole-body vibration and repeated mechanical shock during routine operations…</p>
              </div>
              <div className="mt-10 pt-4 border-t border-slate-200 text-[10px] font-mono text-slate-400 tabular-nums">
                Document hash · sha256 7b21d9f4...e3a8 · Corpus version 2026.05 · Audit chain entry 14
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
