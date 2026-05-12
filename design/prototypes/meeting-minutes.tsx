import React, { useState, useEffect, useRef } from 'react';
import {
  ArrowLeft,
  ChevronRight,
  ChevronDown,
  Plus,
  Filter,
  Search,
  MoreHorizontal,
  Clock,
  CheckCircle2,
  AlertCircle,
  Circle,
  ArrowRight,
  X,
  FileDown,
  Calendar,
  Users,
  ClipboardCheck,
  Hash,
  Upload,
  AlertTriangle,
  Sparkles,
  GripVertical,
  ChevronUp,
  Tag,
  User,
  Building,
  TrendingUp,
  Eye,
  Edit3,
  Shield,
  History,
  ScrollText,
} from 'lucide-react';

// ============ Mock data ============
const MOCK_ITEMS = [
  // New Business
  { id: 'ai-001', seq: 1, type: 'INSP', desc: 'Salvage pot lid not closing properly, chemical splashing out near filler screens.', action: 'Fix lids on older pots so chemical does not fan out on operators.', raisedBy: 'Worker A', followUp: 'Operations Lead', dept: 'OPS', status: 'In Progress', risk: 'High', startDate: '2026-05-03', age: 9, section: 'new_business', flag: '<21d' },
  { id: 'ai-002', seq: 2, type: 'INSP', desc: 'Heat-resistant gloves only effective for 15 seconds of 50°C exposure. Need higher-rated gloves.', action: 'Source and trial heat gloves with appropriate temperature rating.', raisedBy: 'Worker A', followUp: 'Warehouse Mgr', dept: 'OPS', status: 'In Progress', risk: 'High', startDate: '2026-05-03', age: 9, section: 'new_business', flag: '<21d' },
  { id: 'ai-003', seq: 3, type: 'INSP', desc: 'CIP pipe difficult to remove in morning due to damaged threading.', action: 'Maintenance to inspect and replace damaged pipe sections.', raisedBy: 'Worker A', followUp: 'Warehouse Mgr', dept: 'OPS', status: 'In Progress', risk: 'Medium', startDate: '2026-05-03', age: 9, section: 'new_business', flag: '<21d' },
  // Old Business (some > 21d)
  { id: 'ai-101', seq: 1, type: 'INSP', desc: 'Side panels on F12-14 not replaced after removal. New hardware needed.', action: 'New hardware sourcing in progress, easier to replace going forward.', raisedBy: 'Co-Chair (Worker)', followUp: 'Production Mgr', dept: 'OPS', status: 'In Progress', risk: 'Medium', startDate: '2026-03-03', age: 70, section: 'old_business', flag: null },
  { id: 'ai-102', seq: 2, type: 'INSP', desc: 'Milk receiving processes not followed by drivers.', action: 'Supervisor enforcement plan in development.', raisedBy: 'Worker B', followUp: 'Plant Mgr', dept: 'OPS', status: 'In Progress', risk: 'High', startDate: '2026-03-05', age: 68, section: 'old_business', flag: null },
  { id: 'ai-103', seq: 3, type: 'INSIGHT', desc: 'Top of the ramp by senior supervisor office is slippery.', action: 'Monitor slip incidents and assess for non-slip treatment.', raisedBy: 'Co-Chair (Worker)', followUp: 'H&S Coord', dept: 'OPS', status: 'In Progress', risk: 'Medium', startDate: '2026-03-26', age: 47, section: 'old_business', flag: null },
  { id: 'ai-104', seq: 4, type: 'INSIGHT', desc: 'SOP & binders not accurate to current tasks in CIP.', action: 'Production supervisor revising SOPs and binder content.', raisedBy: 'Co-Chair (Worker)', followUp: 'Warehouse Mgr', dept: 'OPS', status: 'In Progress', risk: 'Low', startDate: '2026-03-19', age: 54, section: 'old_business', flag: null },
  { id: 'ai-105', seq: 5, type: 'INSP', desc: 'Ambient racking area — cracks and potholes causing strain.', action: 'B4 corrosion estimate requested. Quote pending from contractor.', raisedBy: 'Worker C', followUp: 'H&S Coord', dept: 'OPS', status: 'In Progress', risk: 'High', startDate: '2025-04-20', age: 387, section: 'old_business', flag: 'critical' },
  // Recommendation
  { id: 'ai-201', seq: 1, type: 'REC', desc: 'Case Receiving humidity exceeding comfort thresholds. Hygienist to assess.', action: 'Hygrometers to be deployed. Climate control plan TBD.', raisedBy: 'Co-Chair (Worker)', followUp: 'Mgmt Co-Chair', dept: 'OPS', status: 'Response received', risk: 'Medium', startDate: '2025-06-30', age: 316, section: 'recommendation', flag: 'response-received' },
  { id: 'ai-202', seq: 2, type: 'REC', desc: 'Powered lifting devices — vibration concerns at loading dock cycle.', action: 'Safe work procedure being drafted. Comprehensive WBV assessment recommended.', raisedBy: 'Co-Chair (Worker)', followUp: 'Warehouse Mgr', dept: 'OPS', status: 'In Progress', risk: 'Critical', startDate: '2026-05-04', age: 8, section: 'recommendation', flag: 'clock-13d' },
];

const SECTION_META = {
  new_business: { label: 'New Business', short: 'New', color: 'bg-blue-500' },
  old_business: { label: 'Old Business', short: 'Old', color: 'bg-amber-500' },
  recommendation: { label: 'Recommendations', short: 'Recs', color: 'bg-violet-500' },
  completed_this_period: { label: 'Completed', short: 'Done', color: 'bg-emerald-500' },
  archived: { label: 'Archived', short: 'Archive', color: 'bg-slate-400' },
};

const TYPE_META = {
  INSP: { label: 'Inspection', tone: 'bg-blue-50 text-blue-700 border-blue-100' },
  INSIGHT: { label: 'Insight', tone: 'bg-violet-50 text-violet-700 border-violet-100' },
  FLI: { label: 'Floor/Light/Infra', tone: 'bg-amber-50 text-amber-700 border-amber-100' },
  INC: { label: 'Incident', tone: 'bg-red-50 text-red-700 border-red-100' },
  REC: { label: 'Recommendation', tone: 'bg-slate-900 text-white border-slate-900' },
  TRAIN: { label: 'Training', tone: 'bg-emerald-50 text-emerald-700 border-emerald-100' },
  PROC: { label: 'Procedure', tone: 'bg-zinc-100 text-zinc-700 border-zinc-200' },
};

// ============ Main view ============
export default function MeetingMinutesPrototype() {
  const [isDesktop, setIsDesktop] = useState(false);
  const [activeSection, setActiveSection] = useState('all_open');
  const [selectedItem, setSelectedItem] = useState(null);
  const [moveSheetOpen, setMoveSheetOpen] = useState(false);
  const [showMeetingHeader, setShowMeetingHeader] = useState(true);

  useEffect(() => {
    const check = () => setIsDesktop(window.innerWidth >= 1024);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  const filtered = MOCK_ITEMS.filter((it) => {
    if (activeSection === 'all_open') return it.section !== 'archived' && it.status !== 'Closed';
    if (activeSection === 'past_21d') return it.age > 21 && it.section !== 'archived' && it.section !== 'recommendation';
    return it.section === activeSection;
  });

  const counts = {
    new_business: MOCK_ITEMS.filter((i) => i.section === 'new_business').length,
    old_business: MOCK_ITEMS.filter((i) => i.section === 'old_business').length,
    recommendation: MOCK_ITEMS.filter((i) => i.section === 'recommendation').length,
    completed_this_period: MOCK_ITEMS.filter((i) => i.section === 'completed_this_period').length,
    past_21d: MOCK_ITEMS.filter((i) => i.age > 21 && i.section !== 'archived' && i.section !== 'recommendation').length,
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 antialiased" style={{ fontFamily: 'Inter, -apple-system, system-ui, sans-serif' }}>
      <div className="flex flex-col min-h-screen">
        {/* App header */}
        <header className="sticky top-0 z-30 bg-white/95 backdrop-blur border-b border-slate-200">
          <div className="px-4 lg:px-6 py-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <div>
                <div className="text-lg font-semibold tracking-tight">Minutes</div>
                <div className="text-[11px] text-slate-500">Active meeting · May 12, 2026</div>
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button className="hidden sm:inline-flex h-9 px-3 rounded-md border border-slate-200 text-xs font-medium text-slate-700 hover:border-slate-300 hover:bg-slate-50 items-center gap-1.5">
                <Upload className="w-3.5 h-3.5" strokeWidth={2} />
                Import Excel
              </button>
              <button className="hidden sm:inline-flex h-9 px-3 rounded-md bg-slate-900 text-white text-xs font-medium hover:bg-slate-800 items-center gap-1.5">
                <Plus className="w-3.5 h-3.5" strokeWidth={2} />
                Add item
              </button>
              <button className="h-9 w-9 rounded-md hover:bg-slate-100 flex items-center justify-center text-slate-600">
                <MoreHorizontal className="w-[18px] h-[18px]" strokeWidth={2} />
              </button>
            </div>
          </div>
        </header>

        {/* Meeting header (collapsible on mobile) */}
        {showMeetingHeader && <MeetingMetadata onCollapse={() => setShowMeetingHeader(false)} />}
        {!showMeetingHeader && (
          <button onClick={() => setShowMeetingHeader(true)} className="bg-white border-b border-slate-200 px-4 lg:px-6 py-2 flex items-center justify-between text-xs text-slate-500 hover:bg-slate-50">
            <span className="inline-flex items-center gap-1.5">
              <Calendar className="w-3 h-3" strokeWidth={2} />
              Meeting · May 12 · 7 NB · 13 OB · 2 Rec
            </span>
            <ChevronDown className="w-3 h-3" strokeWidth={2} />
          </button>
        )}

        {/* Section tabs */}
        <SectionTabs activeSection={activeSection} setActiveSection={setActiveSection} counts={counts} />

        {/* Filter bar */}
        <div className="bg-white border-b border-slate-200 px-4 lg:px-6 py-2 flex items-center gap-2 overflow-x-auto">
          <button className="shrink-0 h-7 px-2.5 rounded-md text-xs font-medium text-slate-600 hover:bg-slate-100 flex items-center gap-1">
            <Filter className="w-3 h-3" strokeWidth={2.25} />
            Type
          </button>
          <button className="shrink-0 h-7 px-2.5 rounded-md text-xs font-medium text-slate-600 hover:bg-slate-100 flex items-center gap-1">
            <Tag className="w-3 h-3" strokeWidth={2.25} />
            Risk
          </button>
          <button className="shrink-0 h-7 px-2.5 rounded-md text-xs font-medium text-slate-600 hover:bg-slate-100 flex items-center gap-1">
            <User className="w-3 h-3" strokeWidth={2.25} />
            Owner
          </button>
          <button className="shrink-0 h-7 px-2.5 rounded-md text-xs font-medium text-slate-600 hover:bg-slate-100 flex items-center gap-1">
            <Building className="w-3 h-3" strokeWidth={2.25} />
            Dept
          </button>
          <div className="ml-auto shrink-0 flex items-center gap-1.5">
            <span className="text-[11px] text-slate-500 tabular-nums">{filtered.length} item{filtered.length !== 1 && 's'}</span>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 flex">
          <div className={`flex-1 overflow-y-auto pb-24 ${selectedItem && isDesktop ? 'border-r border-slate-200' : ''}`}>
            <div className={`${selectedItem && isDesktop ? '' : 'max-w-5xl mx-auto'} px-4 lg:px-6 py-4`}>
              {filtered.length === 0 ? (
                <EmptyState section={activeSection} />
              ) : (
                <div className="space-y-2">
                  {filtered.map((item) => (
                    <ActionItemCard
                      key={item.id}
                      item={item}
                      onClick={() => setSelectedItem(item)}
                      selected={selectedItem?.id === item.id}
                      onMove={() => { setSelectedItem(item); setMoveSheetOpen(true); }}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Detail pane (desktop) */}
          {selectedItem && isDesktop && (
            <ActionItemDetail
              item={selectedItem}
              onClose={() => setSelectedItem(null)}
              onMove={() => setMoveSheetOpen(true)}
              embedded
            />
          )}
        </div>
      </div>

      {/* Detail (mobile full-screen) */}
      {selectedItem && !isDesktop && (
        <div className="fixed inset-0 z-40 bg-slate-50 flex flex-col animate-in slide-in-from-right duration-200">
          <ActionItemDetail
            item={selectedItem}
            onClose={() => setSelectedItem(null)}
            onMove={() => setMoveSheetOpen(true)}
            embedded={false}
          />
        </div>
      )}

      {/* Mobile FAB */}
      {!isDesktop && !selectedItem && (
        <button className="fixed bottom-6 right-4 z-30 w-14 h-14 rounded-full bg-slate-900 text-white shadow-lg shadow-slate-900/20 flex items-center justify-center active:scale-95 transition-transform">
          <Plus className="w-6 h-6" strokeWidth={2.25} />
        </button>
      )}

      {/* Move sheet */}
      {moveSheetOpen && selectedItem && (
        <MoveItemSheet item={selectedItem} onClose={() => setMoveSheetOpen(false)} counts={counts} />
      )}
    </div>
  );
}

// ============ Meeting metadata block ============
function MeetingMetadata({ onCollapse }) {
  return (
    <div className="bg-white border-b border-slate-200 px-4 lg:px-6 py-3 lg:py-4">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            <div className="flex items-center gap-2 mb-0.5">
              <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-100">
                <span className="block w-1 h-1 rounded-full bg-emerald-500" />
                Active meeting
              </span>
              <span className="text-[11px] text-slate-500 tabular-nums">Tuesday, May 12, 2026</span>
            </div>
            <div className="text-base font-semibold text-slate-900">Monthly JHSC Meeting</div>
          </div>
          <button onClick={onCollapse} className="h-7 w-7 rounded-md hover:bg-slate-100 flex items-center justify-center text-slate-500">
            <ChevronUp className="w-4 h-4" strokeWidth={2} />
          </button>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mb-3">
          <Metric label="New" value="7" tone="text-blue-700 bg-blue-50" />
          <Metric label="Old" value="13" tone="text-amber-700 bg-amber-50" />
          <Metric label="Recs" value="2" tone="text-violet-700 bg-violet-50" />
          <Metric label="Closed" value="0" tone="text-emerald-700 bg-emerald-50" />
          <Metric label="Oldest" value="387d" tone="text-red-700 bg-red-50" />
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
          <span className="inline-flex items-center gap-1">
            <Users className="w-3 h-3" strokeWidth={2.25} />
            <span className="tabular-nums">12 present</span>
          </span>
          <span className="text-slate-300">·</span>
          <span className="inline-flex items-center gap-1">
            <ClipboardCheck className="w-3 h-3" strokeWidth={2.25} />
            Quorum met
          </span>
          <span className="text-slate-300">·</span>
          <span className="inline-flex items-center gap-1">
            <Hash className="w-3 h-3" strokeWidth={2.25} />
            <span className="font-mono">audit chain entry 247</span>
          </span>
        </div>
      </div>
    </div>
  );
}

function Metric({ label, value, tone }) {
  return (
    <div className={`rounded-md px-2.5 py-1.5 ${tone}`}>
      <div className="text-[9px] uppercase tracking-wide font-semibold opacity-75 mb-0.5">{label}</div>
      <div className="text-base font-semibold tabular-nums leading-none">{value}</div>
    </div>
  );
}

// ============ Section tabs ============
function SectionTabs({ activeSection, setActiveSection, counts }) {
  const tabs = [
    { id: 'all_open', label: 'All open', short: 'All', count: counts.new_business + counts.old_business + counts.recommendation },
    { id: 'new_business', label: 'New', short: 'New', count: counts.new_business },
    { id: 'old_business', label: 'Old', short: 'Old', count: counts.old_business },
    { id: 'recommendation', label: 'Recs', short: 'Recs', count: counts.recommendation },
    { id: 'past_21d', label: 'Past 21d', short: '>21d', count: counts.past_21d, danger: counts.past_21d > 0 },
    { id: 'completed_this_period', label: 'Done', short: 'Done', count: counts.completed_this_period },
  ];

  return (
    <div className="bg-white border-b border-slate-200 sticky top-[57px] z-20">
      <div className="px-2 lg:px-6 overflow-x-auto">
        <div className="flex items-center gap-px min-w-fit">
          {tabs.map((tab) => {
            const active = activeSection === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveSection(tab.id)}
                className={`shrink-0 h-11 px-3 lg:px-4 flex items-center gap-1.5 text-xs font-medium border-b-2 transition-colors ${
                  active
                    ? 'border-slate-900 text-slate-900'
                    : 'border-transparent text-slate-500 hover:text-slate-900'
                }`}
              >
                <span>{tab.label}</span>
                {tab.count !== undefined && tab.count > 0 && (
                  <span className={`tabular-nums text-[10px] font-mono px-1.5 py-0.5 rounded ${
                    tab.danger ? 'bg-red-100 text-red-700' : active ? 'bg-slate-100 text-slate-700' : 'bg-slate-100 text-slate-500'
                  }`}>
                    {tab.count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ============ Action item card ============
function ActionItemCard({ item, onClick, selected, onMove }) {
  const typeMeta = TYPE_META[item.type] || TYPE_META.INSP;
  const sectionMeta = SECTION_META[item.section];

  return (
    <button
      onClick={onClick}
      className={`w-full text-left bg-white border rounded-lg p-3.5 transition-all group ${
        selected
          ? 'border-slate-900 ring-1 ring-slate-900'
          : 'border-slate-200 hover:border-slate-300'
      }`}
    >
      <div className="flex items-start gap-3">
        <div className="pt-0.5 shrink-0">
          <RiskDot risk={item.risk} />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 mb-1 flex-wrap">
            <span className="text-[10px] font-mono text-slate-500 tabular-nums">#{item.seq}</span>
            <span className={`text-[9px] font-semibold uppercase tracking-wide px-1 py-0.5 rounded border ${typeMeta.tone}`}>
              {item.type}
            </span>
            <StatusBadge status={item.status} />
            <ActionFlag flag={item.flag} age={item.age} section={item.section} />
          </div>
          <div className="text-sm text-slate-900 leading-snug mb-1.5 line-clamp-2">
            {item.desc}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-slate-500">
            <span className="inline-flex items-center gap-1">
              <User className="w-2.5 h-2.5" strokeWidth={2.25} />
              {item.followUp}
            </span>
            <span className="text-slate-300">·</span>
            <span className="tabular-nums">{item.dept}</span>
            <span className="text-slate-300">·</span>
            <span className="tabular-nums">{item.age}d open</span>
          </div>
        </div>

        <div className="flex flex-col items-end gap-1 shrink-0">
          <button
            onClick={(e) => { e.stopPropagation(); onMove(); }}
            className="opacity-0 group-hover:opacity-100 h-7 w-7 rounded-md hover:bg-slate-100 flex items-center justify-center text-slate-500 transition-opacity"
            title="Move to section"
          >
            <ArrowRight className="w-3.5 h-3.5" strokeWidth={2} />
          </button>
          <ChevronRight className="w-4 h-4 text-slate-300 group-hover:text-slate-500 transition-colors" strokeWidth={2} />
        </div>
      </div>
    </button>
  );
}

function RiskDot({ risk }) {
  const colors = {
    Critical: 'bg-red-500',
    High: 'bg-orange-500',
    Medium: 'bg-amber-500',
    Low: 'bg-slate-400',
  };
  return <span className={`block w-2 h-2 rounded-full ${colors[risk] || 'bg-slate-400'}`} />;
}

function StatusBadge({ status }) {
  const styles = {
    'Not Started': 'bg-zinc-100 text-zinc-700',
    'In Progress': 'bg-blue-50 text-blue-700 border-blue-100',
    'Blocked': 'bg-red-50 text-red-700 border-red-100',
    'Pending Review': 'bg-amber-50 text-amber-700 border-amber-100',
    'Closed': 'bg-emerald-50 text-emerald-700 border-emerald-100',
    'Response received': 'bg-emerald-50 text-emerald-700 border-emerald-100',
    'Cancelled': 'bg-zinc-100 text-zinc-600',
  };
  return (
    <span className={`text-[9px] font-medium px-1.5 py-0.5 rounded border ${styles[status] || styles['In Progress']} uppercase tracking-wide`}>
      {status}
    </span>
  );
}

function ActionFlag({ flag, age, section }) {
  if (section === 'archived') return null;

  if (flag === 'critical') {
    return (
      <span className="text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-red-100 text-red-700 inline-flex items-center gap-1">
        🟠 {age}d open
      </span>
    );
  }
  if (flag === 'clock-13d') {
    return (
      <span className="text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 inline-flex items-center gap-1">
        🟡 13d to s.9(21)
      </span>
    );
  }
  if (flag === 'response-received') {
    return (
      <span className="text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 inline-flex items-center gap-1">
        ✓ Response received
      </span>
    );
  }
  if (flag === '<21d') {
    return (
      <span className="text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 inline-flex items-center gap-1">
        🟠 {age}d / 21
      </span>
    );
  }
  return null;
}

// ============ Empty state ============
function EmptyState({ section }) {
  const meta = section === 'past_21d'
    ? { title: 'Nothing past 21 days.', body: 'New Business items move to Old Business automatically when they pass the 21-day mark. Good place to be.' }
    : { title: `No items in ${SECTION_META[section]?.label || section}.`, body: 'Tap the + button to add one, or import from your existing minutes Excel file.' };

  return (
    <div className="flex flex-col items-center justify-center text-center py-20 px-6">
      <div className="w-12 h-12 rounded-lg bg-slate-100 flex items-center justify-center mb-4">
        <CheckCircle2 className="w-6 h-6 text-slate-400" strokeWidth={1.75} />
      </div>
      <div className="text-base font-medium text-slate-900 mb-1">{meta.title}</div>
      <div className="text-sm text-slate-500 max-w-sm">{meta.body}</div>
      <div className="flex items-center gap-2 mt-4">
        <button className="h-9 px-3 rounded-md bg-slate-900 text-white text-xs font-medium hover:bg-slate-800 inline-flex items-center gap-1.5">
          <Plus className="w-3.5 h-3.5" strokeWidth={2} />
          New action item
        </button>
        <button className="h-9 px-3 rounded-md border border-slate-200 text-slate-700 text-xs font-medium hover:bg-slate-50 inline-flex items-center gap-1.5">
          <Upload className="w-3.5 h-3.5" strokeWidth={2} />
          Import Excel
        </button>
      </div>
    </div>
  );
}

// ============ Detail pane ============
function ActionItemDetail({ item, onClose, onMove, embedded }) {
  const typeMeta = TYPE_META[item.type] || TYPE_META.INSP;
  const sectionMeta = SECTION_META[item.section];

  return (
    <div className={`${embedded ? 'w-[440px] shrink-0' : 'flex-1'} bg-white flex flex-col`}>
      <div className="sticky top-0 bg-white/95 backdrop-blur border-b border-slate-200 px-4 lg:px-5 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          {!embedded && (
            <button onClick={onClose} className="h-9 w-9 -ml-2 rounded-md hover:bg-slate-100 flex items-center justify-center text-slate-700">
              <ArrowLeft className="w-5 h-5" strokeWidth={2} />
            </button>
          )}
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 mb-0.5">
              <span className="text-[11px] font-mono text-slate-500 tabular-nums">#{item.seq}</span>
              <span className={`text-[9px] font-semibold uppercase tracking-wide px-1 py-0.5 rounded border ${typeMeta.tone}`}>
                {item.type}
              </span>
              <span className="text-[11px] text-slate-500">in</span>
              <span className="text-[11px] font-medium text-slate-700">{sectionMeta?.label}</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button onClick={onMove} className="h-9 px-2.5 rounded-md hover:bg-slate-100 flex items-center gap-1 text-xs font-medium text-slate-700">
            <ArrowRight className="w-3.5 h-3.5" strokeWidth={2} />
            Move
          </button>
          <button className="h-9 w-9 rounded-md hover:bg-slate-100 flex items-center justify-center text-slate-600">
            <Edit3 className="w-4 h-4" strokeWidth={2} />
          </button>
          {embedded && (
            <button onClick={onClose} className="h-9 w-9 rounded-md hover:bg-slate-100 flex items-center justify-center text-slate-600">
              <X className="w-4 h-4" strokeWidth={2} />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 lg:px-5 py-5">
        {/* Title block */}
        <div className="mb-5">
          <div className="flex items-center gap-2 mb-2 flex-wrap">
            <StatusBadge status={item.status} />
            <span className={`text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded border inline-flex items-center gap-1 ${
              item.risk === 'Critical' ? 'bg-red-50 text-red-700 border-red-100' :
              item.risk === 'High' ? 'bg-orange-50 text-orange-700 border-orange-100' :
              item.risk === 'Medium' ? 'bg-amber-50 text-amber-700 border-amber-100' :
              'bg-slate-100 text-slate-600 border-slate-200'
            }`}>
              <RiskDot risk={item.risk} />
              {item.risk} risk
            </span>
            <ActionFlag flag={item.flag} age={item.age} section={item.section} />
          </div>
          <h1 className="text-lg lg:text-xl font-semibold tracking-tight text-slate-900 leading-snug">
            {item.desc}
          </h1>
        </div>

        {/* Metadata grid */}
        <div className="grid grid-cols-2 gap-3 mb-6 pb-6 border-b border-slate-100">
          <Field label="Raised by" value={item.raisedBy} />
          <Field label="Follow up" value={item.followUp} />
          <Field label="Department" value={item.dept} mono />
          <Field label="Start date" value={item.startDate} mono />
          <Field label="Age" value={`${item.age} days`} mono />
          <Field label="Risk" value={item.risk} />
        </div>

        {/* Recommended action */}
        <Section label="Recommended action">
          <p className="text-sm text-slate-700 leading-relaxed">{item.action}</p>
        </Section>

        {/* Linked records */}
        <Section label="Linked records" trailing={
          <button className="text-xs font-medium text-slate-500 hover:text-slate-900 inline-flex items-center gap-0.5">
            <Plus className="w-3 h-3" strokeWidth={2.5} />
            Link
          </button>
        }>
          <button className="w-full text-left bg-slate-50 border border-slate-200 rounded-lg p-3 hover:bg-slate-100 transition-colors">
            <div className="flex items-start gap-2.5">
              <span className="block w-1.5 h-1.5 rounded-full bg-red-500 mt-1.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="text-[11px] font-mono text-slate-500 tabular-nums">H-047</span>
                  <span className="text-[9px] font-medium px-1 py-0.5 rounded bg-red-50 text-red-700 border border-red-100 uppercase tracking-wide">
                    Hazard
                  </span>
                </div>
                <div className="text-xs font-medium text-slate-900">Whole-body vibration — loading dock cycle</div>
                <div className="text-[11px] text-slate-500 mt-0.5">Critical · Open 12d</div>
              </div>
              <ChevronRight className="w-3.5 h-3.5 text-slate-400" strokeWidth={2} />
            </div>
          </button>
        </Section>

        {/* Section history */}
        <Section label="Section history" count={3}>
          <div className="space-y-2.5">
            <HistoryRow icon={Plus} label="Raised in New Business" actor="Worker A" date={item.startDate} accent="blue" />
            <HistoryRow icon={ArrowRight} label="Moved to Old Business" actor="Worker Co-Chair" date="2026-03-26" reason="Item past 21 days, ongoing" />
            <HistoryRow icon={Edit3} label="Status updated to In Progress" actor="Operations Lead" date="2026-04-15" />
          </div>
        </Section>

        {/* Audit anchor */}
        <button className="w-full mt-2 mb-2 bg-slate-50 border border-slate-200 rounded-lg p-3 flex items-center gap-3 hover:bg-slate-100 transition-colors text-left">
          <div className="w-7 h-7 rounded-md bg-white border border-slate-200 flex items-center justify-center shrink-0">
            <Shield className="w-3.5 h-3.5 text-slate-600" strokeWidth={2} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-xs font-medium text-slate-900">Audit chain · 6 entries</div>
            <div className="text-[10px] text-slate-500 font-mono tabular-nums truncate">sha256 a3f4d2c1...b8e3</div>
          </div>
          <ChevronRight className="w-3.5 h-3.5 text-slate-400" strokeWidth={2} />
        </button>
      </div>

      {/* Bottom action bar */}
      <div className="border-t border-slate-200 px-4 lg:px-5 py-3 bg-white">
        <div className="grid grid-cols-2 gap-2">
          <button className="h-10 rounded-md border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-50 inline-flex items-center justify-center gap-1.5">
            <Eye className="w-3.5 h-3.5" strokeWidth={2} />
            Mark for review
          </button>
          <button className="h-10 rounded-md bg-emerald-600 text-white text-xs font-medium hover:bg-emerald-700 inline-flex items-center justify-center gap-1.5">
            <CheckCircle2 className="w-3.5 h-3.5" strokeWidth={2} />
            Verify closed
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, value, mono }) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 mb-0.5">{label}</div>
      <div className={`text-sm text-slate-900 ${mono ? 'font-mono tabular-nums' : ''}`}>{value}</div>
    </div>
  );
}

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

function HistoryRow({ icon: Icon, label, actor, date, reason, accent }) {
  return (
    <div className="flex items-start gap-2.5">
      <div className={`w-6 h-6 rounded-md ${accent === 'blue' ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-600'} flex items-center justify-center shrink-0 mt-0.5`}>
        <Icon className="w-3 h-3" strokeWidth={2} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-xs text-slate-900 leading-snug">{label}</div>
        <div className="text-[10px] text-slate-500 mt-0.5 tabular-nums">
          {actor} · {date}
        </div>
        {reason && <div className="text-[10px] text-slate-500 mt-0.5 italic">"{reason}"</div>}
      </div>
    </div>
  );
}

// ============ Move sheet ============
function MoveItemSheet({ item, onClose, counts }) {
  const sections = [
    { id: 'new_business', label: 'New Business', desc: 'Just raised this period' },
    { id: 'old_business', label: 'Old Business', desc: 'Carried over, still open' },
    { id: 'recommendation', label: 'Notice of Recommendation', desc: 'Formal s.9(20) recommendation' },
    { id: 'completed_this_period', label: 'Completed', desc: 'Verified closed this period' },
    { id: 'archived', label: 'Archive', desc: 'Move to historical archive' },
  ];

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-sm flex items-end lg:items-center lg:justify-center" onClick={onClose}>
      <div
        className="w-full lg:max-w-md bg-white lg:mx-4 rounded-t-2xl lg:rounded-xl border-t lg:border border-slate-200 overflow-hidden animate-in slide-in-from-bottom lg:zoom-in-95 duration-200 flex flex-col"
        style={{ maxHeight: '85vh', paddingBottom: 'env(safe-area-inset-bottom)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-center pt-3 lg:hidden">
          <div className="w-10 h-1 rounded-full bg-slate-200" />
        </div>
        <div className="px-5 py-4 border-b border-slate-200 flex items-start justify-between gap-3">
          <div>
            <div className="text-base font-semibold mb-0.5">Move action item</div>
            <div className="text-[11px] text-slate-500 font-mono tabular-nums">#{item.seq} · Currently in {SECTION_META[item.section]?.label}</div>
          </div>
          <button onClick={onClose} className="h-8 w-8 -mr-2 rounded-md hover:bg-slate-100 flex items-center justify-center">
            <X className="w-4 h-4 text-slate-500" strokeWidth={2} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto py-2">
          {sections.map((s) => {
            const isCurrent = s.id === item.section;
            return (
              <button
                key={s.id}
                disabled={isCurrent}
                className={`w-full text-left px-5 py-3 flex items-center gap-3 transition-colors group ${
                  isCurrent ? 'opacity-40 cursor-not-allowed' : 'hover:bg-slate-50'
                }`}
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-slate-900">{s.label}</div>
                  <div className="text-[11px] text-slate-500">{s.desc}</div>
                </div>
                {isCurrent ? (
                  <span className="text-[10px] font-medium uppercase tracking-wide text-slate-400">Current</span>
                ) : (
                  <ArrowRight className="w-4 h-4 text-slate-400 group-hover:text-slate-700" strokeWidth={2} />
                )}
              </button>
            );
          })}
        </div>

        <div className="px-5 py-3 border-t border-slate-200 bg-slate-50">
          <div className="text-[10px] text-slate-500 flex items-center gap-1.5">
            <Shield className="w-3 h-3" strokeWidth={2} />
            Every move is recorded in the audit chain with timestamp and your identity.
          </div>
        </div>
      </div>
    </div>
  );
}
