import React, { useState, useEffect, useRef } from 'react';
import {
  LayoutDashboard,
  AlertTriangle,
  ClipboardList,
  FileText,
  MoreHorizontal,
  Search,
  Bell,
  Plus,
  ChevronRight,
  Clock,
  CheckCircle2,
  AlertCircle,
  Circle,
  Calendar,
  BookOpen,
  Calculator,
  BarChart3,
  Settings,
  Shield,
  Camera,
  Mic,
  MapPin,
  X,
  ArrowRight,
  Hash,
} from 'lucide-react';

export default function JHSCWorkerHub() {
  const [activeTab, setActiveTab] = useState('dashboard');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [fabMenuOpen, setFabMenuOpen] = useState(false);
  const [isDesktop, setIsDesktop] = useState(false);
  const paletteInputRef = useRef(null);

  useEffect(() => {
    const check = () => setIsDesktop(window.innerWidth >= 768);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setPaletteOpen(true);
      }
      if (e.key === 'Escape') {
        setPaletteOpen(false);
        setFabMenuOpen(false);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  useEffect(() => {
    if (paletteOpen && paletteInputRef.current) {
      setTimeout(() => paletteInputRef.current?.focus(), 50);
    }
  }, [paletteOpen]);

  const tabs = [
    { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { id: 'hazards', label: 'Hazards', icon: AlertTriangle },
    { id: 'inspections', label: 'Inspections', icon: ClipboardList },
    { id: 'recommendations', label: 'Recs', icon: FileText },
    { id: 'more', label: 'More', icon: MoreHorizontal },
  ];

  const sidebarItems = [
    { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { id: 'hazards', label: 'Hazards', icon: AlertTriangle, count: 4 },
    { id: 'inspections', label: 'Inspections', icon: ClipboardList },
    { id: 'recommendations', label: 'Recommendations', icon: FileText, count: 3 },
    { type: 'divider' },
    { id: 'documents', label: 'Documents', icon: FileText },
    { id: 'legal', label: 'Legal Reference', icon: BookOpen },
    { id: 'calculators', label: 'Calculators', icon: Calculator },
    { id: 'analytics', label: 'Analytics', icon: BarChart3 },
    { id: 'calendar', label: 'Calendar', icon: Calendar },
    { type: 'divider' },
    { id: 'settings', label: 'Settings', icon: Settings },
  ];

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 antialiased" style={{ fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, system-ui, sans-serif' }}>
      <div className="flex min-h-screen">
        {/* Desktop sidebar */}
        {isDesktop && (
          <aside className="w-60 border-r border-slate-200 bg-white flex flex-col">
            <div className="px-4 py-4 border-b border-slate-200">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded bg-slate-900 flex items-center justify-center">
                  <Shield className="w-4 h-4 text-white" strokeWidth={2.25} />
                </div>
                <div className="text-sm font-semibold tracking-tight">JHSC Worker Hub</div>
              </div>
            </div>
            <nav className="flex-1 px-2 py-3 overflow-y-auto">
              {sidebarItems.map((item, i) => {
                if (item.type === 'divider') {
                  return <div key={i} className="my-2 border-t border-slate-200" />;
                }
                const Icon = item.icon;
                const active = activeTab === item.id;
                return (
                  <button
                    key={item.id}
                    onClick={() => setActiveTab(item.id)}
                    className={`w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded text-sm transition-colors ${
                      active
                        ? 'bg-slate-100 text-slate-900 font-medium'
                        : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                    }`}
                  >
                    <Icon className="w-4 h-4" strokeWidth={2} />
                    <span className="flex-1 text-left">{item.label}</span>
                    {item.count && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-red-50 text-red-700 font-medium tabular-nums">
                        {item.count}
                      </span>
                    )}
                  </button>
                );
              })}
            </nav>
            <div className="px-3 py-3 border-t border-slate-200">
              <div className="flex items-center gap-2.5 px-1">
                <div className="w-7 h-7 rounded-full bg-slate-200 flex items-center justify-center text-xs font-medium text-slate-600">
                  WC
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium text-slate-900 truncate">Worker Co-Chair</div>
                  <div className="text-[11px] text-slate-500 truncate">JHSC</div>
                </div>
                <div className="flex items-center gap-1">
                  <div className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                  <span className="text-[10px] text-slate-500 font-medium tabular-nums">Synced</span>
                </div>
              </div>
            </div>
          </aside>
        )}

        {/* Main area */}
        <main className="flex-1 flex flex-col min-w-0">
          {/* Top bar */}
          <header className="sticky top-0 z-20 bg-white/95 backdrop-blur border-b border-slate-200">
            <div className="flex items-center justify-between h-14 px-4 md:px-6">
              {!isDesktop && (
                <div className="flex items-center gap-2">
                  <div className="w-7 h-7 rounded bg-slate-900 flex items-center justify-center">
                    <Shield className="w-4 h-4 text-white" strokeWidth={2.25} />
                  </div>
                  <div className="text-sm font-semibold tracking-tight">JHSC Worker Hub</div>
                </div>
              )}
              {isDesktop && (
                <div className="flex items-center gap-2 text-sm text-slate-500">
                  <span className="text-slate-900 font-medium capitalize">{activeTab}</span>
                </div>
              )}
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setPaletteOpen(true)}
                  className="flex items-center gap-2 h-9 px-3 rounded-md border border-slate-200 bg-white text-slate-500 hover:border-slate-300 hover:text-slate-700 transition-colors text-sm"
                  aria-label="Search"
                >
                  <Search className="w-4 h-4" strokeWidth={2} />
                  {isDesktop && (
                    <>
                      <span className="hidden md:inline">Search or jump to…</span>
                      <kbd className="ml-6 px-1.5 py-0.5 rounded bg-slate-100 text-[10px] font-mono text-slate-500 border border-slate-200">
                        ⌘K
                      </kbd>
                    </>
                  )}
                </button>
                <button
                  className="relative h-9 w-9 rounded-md hover:bg-slate-100 flex items-center justify-center text-slate-600 hover:text-slate-900 transition-colors"
                  aria-label="Notifications"
                >
                  <Bell className="w-[18px] h-[18px]" strokeWidth={2} />
                  <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full bg-red-500" />
                </button>
              </div>
            </div>
          </header>

          {/* Content */}
          <div className="flex-1 overflow-y-auto pb-20 md:pb-6">
            {activeTab === 'dashboard' && <DashboardView setActiveTab={setActiveTab} />}
            {activeTab === 'hazards' && <HazardsView />}
            {activeTab === 'inspections' && <PlaceholderView title="Inspections" icon={ClipboardList} />}
            {activeTab === 'recommendations' && <RecommendationsView />}
            {activeTab === 'more' && <MoreView />}
            {['documents', 'legal', 'calculators', 'analytics', 'calendar', 'settings'].includes(activeTab) && (
              <PlaceholderView
                title={activeTab.charAt(0).toUpperCase() + activeTab.slice(1)}
                icon={sidebarItems.find((i) => i.id === activeTab)?.icon || FileText}
              />
            )}
          </div>
        </main>
      </div>

      {/* Mobile bottom tab bar */}
      {!isDesktop && (
        <nav className="fixed bottom-0 left-0 right-0 z-30 bg-white border-t border-slate-200" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
          <div className="grid grid-cols-5 h-16">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              const active = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex flex-col items-center justify-center gap-1 transition-colors ${
                    active ? 'text-slate-900' : 'text-slate-400'
                  }`}
                >
                  <Icon className="w-5 h-5" strokeWidth={active ? 2.25 : 2} />
                  <span className={`text-[10px] tracking-tight ${active ? 'font-semibold' : 'font-medium'}`}>
                    {tab.label}
                  </span>
                </button>
              );
            })}
          </div>
        </nav>
      )}

      {/* Mobile FAB */}
      {!isDesktop && (
        <>
          <button
            onClick={() => setFabMenuOpen(true)}
            className="fixed bottom-20 right-4 z-30 w-14 h-14 rounded-full bg-slate-900 text-white shadow-lg shadow-slate-900/20 flex items-center justify-center hover:bg-slate-800 active:scale-95 transition-all"
            style={{ marginBottom: 'env(safe-area-inset-bottom)' }}
            aria-label="Quick capture"
          >
            <Plus className="w-6 h-6" strokeWidth={2.25} />
          </button>

          {fabMenuOpen && (
            <div
              className="fixed inset-0 z-40 bg-slate-900/40 backdrop-blur-sm flex items-end animate-in fade-in duration-150"
              onClick={() => setFabMenuOpen(false)}
            >
              <div
                className="w-full bg-white rounded-t-2xl border-t border-slate-200 animate-in slide-in-from-bottom duration-200"
                style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex justify-center pt-3 pb-1">
                  <div className="w-10 h-1 rounded-full bg-slate-200" />
                </div>
                <div className="px-4 pt-2 pb-1">
                  <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Quick Capture</div>
                </div>
                <div className="px-2 pb-4">
                  <FabAction icon={Camera} label="Photo evidence" sub="Camera → encrypted draft hazard" onClick={() => setFabMenuOpen(false)} />
                  <FabAction icon={AlertTriangle} label="New hazard" sub="Standard intake form" onClick={() => setFabMenuOpen(false)} />
                  <FabAction icon={ClipboardList} label="Start inspection" sub="From a sector template" onClick={() => setFabMenuOpen(false)} />
                  <FabAction icon={Mic} label="Voice note" sub="Transcribed to incident log" onClick={() => setFabMenuOpen(false)} />
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {/* Command palette */}
      {paletteOpen && (
        <div
          className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-sm flex items-start justify-center pt-[15vh] md:pt-[20vh] animate-in fade-in duration-100"
          onClick={() => setPaletteOpen(false)}
        >
          <div
            className="w-full max-w-xl mx-4 bg-white rounded-xl border border-slate-200 shadow-2xl shadow-slate-900/10 overflow-hidden animate-in zoom-in-95 duration-100"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 px-4 h-12 border-b border-slate-200">
              <Search className="w-4 h-4 text-slate-400" strokeWidth={2} />
              <input
                ref={paletteInputRef}
                placeholder="Search, navigate, or run a command…"
                className="flex-1 bg-transparent outline-none text-sm placeholder:text-slate-400"
              />
              <kbd className="px-1.5 py-0.5 rounded bg-slate-100 text-[10px] font-mono text-slate-500 border border-slate-200">
                Esc
              </kbd>
            </div>
            <div className="max-h-96 overflow-y-auto py-2">
              <PaletteGroup label="Suggested">
                <PaletteItem icon={Plus} label="New hazard" hint="Start intake form" />
                <PaletteItem icon={Plus} label="New recommendation" hint="Draft a JHSC recommendation" />
                <PaletteItem icon={Camera} label="Capture evidence" hint="Photo → encrypted draft" />
              </PaletteGroup>
              <PaletteGroup label="Recent">
                <PaletteItem icon={FileText} label="RC-003 · Trench drain hazard" hint="Recommendation · Draft" />
                <PaletteItem icon={AlertTriangle} label="H-047 · WBV exposure — dock cycle" hint="Hazard · Critical · Open 12d" />
                <PaletteItem icon={ClipboardList} label="May inspection — Loading dock" hint="Inspection · Completed Apr 28" />
              </PaletteGroup>
              <PaletteGroup label="Jump to">
                <PaletteItem icon={LayoutDashboard} label="Dashboard" />
                <PaletteItem icon={AlertTriangle} label="Hazards" />
                <PaletteItem icon={BookOpen} label="Legal Reference" />
              </PaletteGroup>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function FabAction({ icon: Icon, label, sub, onClick }) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 px-3 py-3 rounded-lg hover:bg-slate-50 transition-colors text-left"
    >
      <div className="w-10 h-10 rounded-lg bg-slate-100 flex items-center justify-center shrink-0">
        <Icon className="w-5 h-5 text-slate-700" strokeWidth={2} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-slate-900">{label}</div>
        <div className="text-xs text-slate-500 truncate">{sub}</div>
      </div>
      <ChevronRight className="w-4 h-4 text-slate-300" strokeWidth={2} />
    </button>
  );
}

function PaletteGroup({ label, children }) {
  return (
    <div className="px-2 mb-1">
      <div className="px-3 pt-2 pb-1 text-[11px] font-semibold text-slate-400 uppercase tracking-wide">{label}</div>
      <div>{children}</div>
    </div>
  );
}

function PaletteItem({ icon: Icon, label, hint }) {
  return (
    <button className="w-full flex items-center gap-3 px-3 py-2 rounded-md hover:bg-slate-100 text-left transition-colors group">
      <Icon className="w-4 h-4 text-slate-500 shrink-0" strokeWidth={2} />
      <div className="flex-1 min-w-0 flex items-baseline gap-2">
        <span className="text-sm text-slate-900 truncate">{label}</span>
        {hint && <span className="text-xs text-slate-500 truncate">{hint}</span>}
      </div>
      <ChevronRight className="w-3.5 h-3.5 text-slate-300 group-hover:text-slate-500 transition-colors" strokeWidth={2} />
    </button>
  );
}

function DashboardView({ setActiveTab }) {
  return (
    <div className="px-4 md:px-6 py-4 md:py-6 max-w-5xl">
      <div className="mb-6 md:mb-8">
        <div className="text-xs text-slate-500 font-medium tabular-nums mb-1">Tuesday · May 12, 2026</div>
        <h1 className="text-2xl md:text-3xl font-semibold tracking-tight text-slate-900">Good afternoon.</h1>
        <p className="text-sm text-slate-500 mt-1">3 items need your attention today.</p>
      </div>

      <SectionHeader title="Needs attention" />
      <div className="space-y-2 mb-8">
        <AttentionRow
          severity="critical"
          id="RC-002"
          title="WBV assessment recommendation"
          subtitle="Response from management due in 13 days"
          meta="Day 8 of 21"
          progress={8 / 21}
        />
        <AttentionRow
          severity="critical"
          id="H-047"
          title="WBV exposure — dock cycle"
          subtitle="Open 12 days · No control assigned"
          meta="Critical"
        />
        <AttentionRow
          severity="warning"
          id="H-046"
          title="Slip hazard — cooler floor"
          subtitle="Management response overdue by 4 days"
          meta="Pending"
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
        <Card>
          <SectionHeader title="Open hazards" trailing={
            <button onClick={() => setActiveTab('hazards')} className="text-xs text-slate-500 hover:text-slate-900 font-medium flex items-center gap-0.5">
              View all <ChevronRight className="w-3 h-3" strokeWidth={2.5} />
            </button>
          } />
          <div className="space-y-px">
            <MiniRow status="open" id="H-047" label="WBV — dock cycle" age="12d" />
            <MiniRow status="pending" id="H-046" label="Slip — cooler floor" age="4d" />
            <MiniRow status="open" id="H-044" label="Noise — compressor room" age="2d" />
            <MiniRow status="open" id="H-043" label="Trench drain — dock" age="18d" />
          </div>
        </Card>

        <Card>
          <SectionHeader title="This week" />
          <div className="space-y-px">
            <ScheduleRow day="Tue" date="May 12" label="RC-002 management response" status="critical" />
            <ScheduleRow day="Thu" date="May 14" label="JHSC monthly meeting" />
            <ScheduleRow day="Fri" date="May 15" label="Loading dock inspection" />
            <ScheduleRow day="Mon" date="May 18" label="Recommendation review" />
          </div>
        </Card>
      </div>

      <SectionHeader title="Active recommendations" trailing={
        <button onClick={() => setActiveTab('recommendations')} className="text-xs text-slate-500 hover:text-slate-900 font-medium flex items-center gap-0.5">
          View all <ChevronRight className="w-3 h-3" strokeWidth={2.5} />
        </button>
      } />
      <div className="space-y-2 mb-8">
        <RecRow id="RC-002" title="Comprehensive WBV assessment" day={8} total={21} status="active" />
        <RecRow id="RC-001" title="Trench drain remediation" day={3} total={21} status="active" />
        <RecRow id="RC-003" title="Cooler floor non-slip treatment" day={null} total={null} status="draft" />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Open hazards" value="4" trend="+1 wk" />
        <Stat label="Resolved (30d)" value="7" trend="+3 mo" />
        <Stat label="Inspections (30d)" value="3" trend="On track" />
        <Stat label="Avg resolution" value="14d" trend="-2d mo" />
      </div>
    </div>
  );
}

function SectionHeader({ title, trailing }) {
  return (
    <div className="flex items-baseline justify-between mb-3">
      <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wide">{title}</h2>
      {trailing}
    </div>
  );
}

function Card({ children }) {
  return <div className="bg-white border border-slate-200 rounded-lg p-4">{children}</div>;
}

function AttentionRow({ severity, id, title, subtitle, meta, progress }) {
  const sevStyle = severity === 'critical'
    ? { dot: 'bg-red-500', tag: 'bg-red-50 text-red-700 border-red-100' }
    : { dot: 'bg-amber-500', tag: 'bg-amber-50 text-amber-700 border-amber-100' };

  return (
    <button className="w-full text-left group bg-white border border-slate-200 rounded-lg p-3.5 hover:border-slate-300 transition-colors">
      <div className="flex items-start gap-3">
        <div className="pt-1">
          <span className={`block w-2 h-2 rounded-full ${sevStyle.dot}`} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-[11px] font-mono text-slate-500 tabular-nums">{id}</span>
            <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded border ${sevStyle.tag} uppercase tracking-wide`}>{meta}</span>
          </div>
          <div className="text-sm font-medium text-slate-900 truncate">{title}</div>
          <div className="text-xs text-slate-500 mt-0.5">{subtitle}</div>
          {progress !== undefined && (
            <div className="mt-2 h-1 bg-slate-100 rounded-full overflow-hidden">
              <div
                className="h-full bg-red-500 rounded-full transition-all"
                style={{ width: `${progress * 100}%` }}
              />
            </div>
          )}
        </div>
        <ChevronRight className="w-4 h-4 text-slate-300 group-hover:text-slate-500 transition-colors mt-1" strokeWidth={2} />
      </div>
    </button>
  );
}

function MiniRow({ status, id, label, age }) {
  const colors = {
    open: 'bg-red-500',
    pending: 'bg-amber-500',
    resolved: 'bg-emerald-500',
  };
  return (
    <div className="flex items-center gap-2.5 py-1.5">
      <span className={`block w-1.5 h-1.5 rounded-full ${colors[status]} shrink-0`} />
      <span className="text-[11px] font-mono text-slate-500 tabular-nums shrink-0">{id}</span>
      <span className="text-sm text-slate-900 flex-1 min-w-0 truncate">{label}</span>
      <span className="text-xs text-slate-500 tabular-nums shrink-0">{age}</span>
    </div>
  );
}

function ScheduleRow({ day, date, label, status }) {
  return (
    <div className="flex items-center gap-3 py-1.5">
      <div className="text-center shrink-0 w-10">
        <div className={`text-[10px] uppercase font-semibold tracking-wide ${status === 'critical' ? 'text-red-600' : 'text-slate-400'}`}>{day}</div>
        <div className="text-xs font-mono text-slate-700 tabular-nums">{date.split(' ')[1]}</div>
      </div>
      <div className="text-sm text-slate-900 flex-1 min-w-0 truncate">{label}</div>
      {status === 'critical' && <span className="block w-1.5 h-1.5 rounded-full bg-red-500" />}
    </div>
  );
}

function RecRow({ id, title, day, total, status }) {
  const statusStyle = status === 'active'
    ? { dot: 'bg-blue-500', tag: 'bg-blue-50 text-blue-700' }
    : { dot: 'bg-slate-400', tag: 'bg-slate-100 text-slate-600' };

  return (
    <button className="w-full text-left bg-white border border-slate-200 rounded-lg p-3.5 hover:border-slate-300 transition-colors group">
      <div className="flex items-start gap-3">
        <span className={`block w-2 h-2 rounded-full ${statusStyle.dot} mt-1.5 shrink-0`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-[11px] font-mono text-slate-500 tabular-nums">{id}</span>
            <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${statusStyle.tag} uppercase tracking-wide`}>
              {status === 'active' ? `Day ${day}/${total}` : 'Draft'}
            </span>
          </div>
          <div className="text-sm font-medium text-slate-900">{title}</div>
        </div>
        <ChevronRight className="w-4 h-4 text-slate-300 group-hover:text-slate-500 mt-1 transition-colors" strokeWidth={2} />
      </div>
    </button>
  );
}

function Stat({ label, value, trend }) {
  return (
    <div className="bg-white border border-slate-200 rounded-lg p-3">
      <div className="text-[11px] font-medium text-slate-500 uppercase tracking-wide mb-1">{label}</div>
      <div className="text-2xl font-semibold text-slate-900 tabular-nums leading-none">{value}</div>
      <div className="text-[11px] text-slate-500 mt-1 tabular-nums">{trend}</div>
    </div>
  );
}

function HazardsView() {
  const hazards = [
    { id: 'H-047', title: 'WBV exposure — dock cycle', severity: 'critical', status: 'open', age: 12, location: 'Loading dock' },
    { id: 'H-046', title: 'Slip hazard — cooler floor', severity: 'high', status: 'pending', age: 4, location: 'Cooler 2' },
    { id: 'H-045', title: 'MSD — pick line repetition', severity: 'high', status: 'resolved', age: null, location: 'Pick line A' },
    { id: 'H-044', title: 'Noise — compressor room', severity: 'medium', status: 'open', age: 2, location: 'Compressor rm' },
    { id: 'H-043', title: 'Trench drain — dock crossing', severity: 'critical', status: 'open', age: 18, location: 'Loading dock' },
    { id: 'H-042', title: 'Ergonomic — case lift station', severity: 'medium', status: 'resolved', age: null, location: 'Case wash' },
  ];

  const sev = (s) => ({
    critical: 'bg-red-500',
    high: 'bg-orange-500',
    medium: 'bg-amber-500',
    low: 'bg-slate-400',
  })[s];

  const stat = (s) => ({
    open: { tag: 'bg-red-50 text-red-700 border-red-100', label: 'Open' },
    pending: { tag: 'bg-amber-50 text-amber-700 border-amber-100', label: 'Pending' },
    resolved: { tag: 'bg-emerald-50 text-emerald-700 border-emerald-100', label: 'Resolved' },
  })[s];

  return (
    <div className="px-4 md:px-6 py-4 md:py-6 max-w-5xl">
      <div className="mb-4 md:mb-6">
        <h1 className="text-2xl md:text-3xl font-semibold tracking-tight text-slate-900">Hazards</h1>
        <p className="text-sm text-slate-500 mt-1">4 open · 2 resolved this month</p>
      </div>

      <div className="flex items-center gap-1.5 mb-4 overflow-x-auto pb-1 -mx-4 px-4 md:mx-0 md:px-0">
        <FilterChip active label="All" count={6} />
        <FilterChip label="Open" count={3} />
        <FilterChip label="Pending" count={1} />
        <FilterChip label="Resolved" count={2} />
        <FilterChip label="Critical" />
      </div>

      <div className="space-y-2">
        {hazards.map((h) => {
          const s = stat(h.status);
          return (
            <button
              key={h.id}
              className="w-full text-left bg-white border border-slate-200 rounded-lg p-3.5 hover:border-slate-300 transition-colors group"
            >
              <div className="flex items-start gap-3">
                <span className={`block w-2 h-2 rounded-full ${sev(h.severity)} mt-1.5 shrink-0`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[11px] font-mono text-slate-500 tabular-nums">{h.id}</span>
                    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded border ${s.tag} uppercase tracking-wide`}>{s.label}</span>
                    <span className="text-[10px] text-slate-400 uppercase tracking-wide font-medium">{h.severity}</span>
                  </div>
                  <div className="text-sm font-medium text-slate-900 mb-1">{h.title}</div>
                  <div className="flex items-center gap-3 text-xs text-slate-500">
                    <span className="flex items-center gap-1">
                      <MapPin className="w-3 h-3" strokeWidth={2} />
                      {h.location}
                    </span>
                    {h.age !== null && (
                      <span className="flex items-center gap-1 tabular-nums">
                        <Clock className="w-3 h-3" strokeWidth={2} />
                        {h.age}d open
                      </span>
                    )}
                  </div>
                </div>
                <ChevronRight className="w-4 h-4 text-slate-300 group-hover:text-slate-500 mt-1 transition-colors" strokeWidth={2} />
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function FilterChip({ active, label, count }) {
  return (
    <button
      className={`shrink-0 inline-flex items-center gap-1.5 h-8 px-3 rounded-full text-xs font-medium transition-colors border ${
        active
          ? 'bg-slate-900 text-white border-slate-900'
          : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300 hover:text-slate-900'
      }`}
    >
      {label}
      {count !== undefined && (
        <span className={`tabular-nums ${active ? 'text-white/70' : 'text-slate-400'}`}>{count}</span>
      )}
    </button>
  );
}

function RecommendationsView() {
  return (
    <div className="px-4 md:px-6 py-4 md:py-6 max-w-5xl">
      <div className="mb-4 md:mb-6">
        <h1 className="text-2xl md:text-3xl font-semibold tracking-tight text-slate-900">Recommendations</h1>
        <p className="text-sm text-slate-500 mt-1">2 active · 1 draft · 21-day clock under OHSA s.9(21)</p>
      </div>

      <div className="space-y-2">
        <RecCard id="RC-002" title="Comprehensive WBV assessment under ISO 2631-1 / 2631-5" day={8} total={21} status="active" />
        <RecCard id="RC-001" title="Trench drain remediation — loading dock" day={3} total={21} status="active" />
        <RecCard id="RC-003" title="Cooler floor non-slip treatment" status="draft" />
      </div>
    </div>
  );
}

function RecCard({ id, title, day, total, status }) {
  const isDraft = status === 'draft';
  return (
    <button className="w-full text-left bg-white border border-slate-200 rounded-lg p-4 hover:border-slate-300 transition-colors group">
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-mono text-slate-500 tabular-nums">{id}</span>
          <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded uppercase tracking-wide ${
            isDraft ? 'bg-slate-100 text-slate-600' : 'bg-blue-50 text-blue-700'
          }`}>
            {isDraft ? 'Draft' : `Day ${day} of ${total}`}
          </span>
        </div>
        <ChevronRight className="w-4 h-4 text-slate-300 group-hover:text-slate-500 transition-colors" strokeWidth={2} />
      </div>
      <div className="text-sm font-medium text-slate-900 mb-3">{title}</div>
      {!isDraft && (
        <div>
          <div className="flex items-center justify-between text-[11px] text-slate-500 mb-1 tabular-nums">
            <span>Submitted Apr {30 - day}</span>
            <span>{total - day} days to response</span>
          </div>
          <div className="h-1 bg-slate-100 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full ${day / total > 0.66 ? 'bg-red-500' : day / total > 0.33 ? 'bg-amber-500' : 'bg-blue-500'}`}
              style={{ width: `${(day / total) * 100}%` }}
            />
          </div>
        </div>
      )}
    </button>
  );
}

function MoreView() {
  const items = [
    { id: 'documents', label: 'Documents', icon: FileText, desc: 'Evidence vault & generated PDFs' },
    { id: 'legal', label: 'Legal Reference', icon: BookOpen, desc: 'OHSA, CLC Part II, CSA standards' },
    { id: 'calculators', label: 'Calculators', icon: Calculator, desc: 'ISO 2631, NIOSH, ACGIH TLV' },
    { id: 'analytics', label: 'Analytics', icon: BarChart3, desc: 'Hazard trends & outcomes' },
    { id: 'calendar', label: 'Calendar', icon: Calendar, desc: 'Meetings, inspections, deadlines' },
    { id: 'settings', label: 'Settings', icon: Settings, desc: 'Account, security, preferences' },
  ];

  return (
    <div className="px-4 py-4 max-w-5xl">
      <div className="mb-4">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">More</h1>
      </div>
      <div className="space-y-2">
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              className="w-full flex items-center gap-3 p-3.5 bg-white border border-slate-200 rounded-lg hover:border-slate-300 transition-colors text-left group"
            >
              <div className="w-9 h-9 rounded-lg bg-slate-100 flex items-center justify-center shrink-0">
                <Icon className="w-[18px] h-[18px] text-slate-700" strokeWidth={2} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-slate-900">{item.label}</div>
                <div className="text-xs text-slate-500 truncate">{item.desc}</div>
              </div>
              <ChevronRight className="w-4 h-4 text-slate-300 group-hover:text-slate-500 transition-colors" strokeWidth={2} />
            </button>
          );
        })}
      </div>
    </div>
  );
}

function PlaceholderView({ title, icon: Icon }) {
  return (
    <div className="px-4 md:px-6 py-12 max-w-5xl">
      <div className="flex flex-col items-center justify-center text-center py-16">
        <div className="w-12 h-12 rounded-lg bg-slate-100 flex items-center justify-center mb-3">
          <Icon className="w-6 h-6 text-slate-400" strokeWidth={1.75} />
        </div>
        <div className="text-base font-medium text-slate-900 mb-1">{title}</div>
        <div className="text-sm text-slate-500 max-w-sm">This screen renders fully in Release 1. Tap any other tab to explore the working surfaces.</div>
      </div>
    </div>
  );
}
