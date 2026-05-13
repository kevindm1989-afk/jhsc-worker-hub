import { Shield } from 'lucide-react';
import { NavLink } from 'react-router-dom';
import { TABS, type TabDefinition } from '@/lib/tabs';
import { cn } from '@/lib/utils';

// Desktop sidebar — 240px wide, hidden below md (mobile uses bottom tab bar).
// Visual anchors: app-shell.tsx:92-145.

export function DesktopSidebar(): JSX.Element {
  const primaryTabs = TABS.filter((t) => !t.secondary);
  const secondaryTabs = TABS.filter((t) => t.secondary);

  return (
    <aside
      className="hidden w-60 shrink-0 flex-col border-r border-border bg-card md:flex"
      aria-label="Primary navigation"
    >
      <div className="border-b border-border px-4 py-4">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded bg-primary">
            <Shield className="h-4 w-4 text-primary-foreground" strokeWidth={2.25} />
          </div>
          <div className="text-sm font-semibold tracking-tight text-foreground">
            JHSC Worker Hub
          </div>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 py-3">
        {primaryTabs.map((tab) => (
          <SidebarItem key={tab.id} tab={tab} />
        ))}
        {secondaryTabs.length > 0 && (
          <>
            <div className="my-2 border-t border-border" aria-hidden="true" />
            {secondaryTabs.map((tab) => (
              <SidebarItem key={tab.id} tab={tab} />
            ))}
          </>
        )}
      </nav>

      {/* Footer — placeholder identity. Real session lands in Milestone 1.2 (auth).
          Real sync state lands in 1.10. Role title "Worker Co-Chair" is allowed
          per non-negotiable #1 (no workplace, person, or local names — role is a
          generic role label). */}
      <div className="border-t border-border px-3 py-3">
        <div className="flex items-center gap-2.5 px-1">
          <div
            className="flex h-7 w-7 items-center justify-center rounded-full bg-secondary text-xs font-medium text-secondary-foreground"
            aria-hidden="true"
          >
            WC
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-medium text-foreground">Worker Co-Chair</div>
            <div className="truncate text-[11px] text-muted-foreground">JHSC</div>
          </div>
          <div className="flex items-center gap-1">
            <span className="h-1.5 w-1.5 rounded-full bg-status-resolved" aria-hidden="true" />
            <span className="text-[10px] font-medium tabular-nums text-muted-foreground">
              Synced
            </span>
          </div>
        </div>
      </div>
    </aside>
  );
}

function SidebarItem({ tab }: { tab: TabDefinition }): JSX.Element {
  const Icon = tab.icon;
  return (
    <NavLink
      to={tab.path}
      className={({ isActive }) =>
        cn(
          'flex w-full items-center gap-2.5 rounded px-2.5 py-1.5 text-sm transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card',
          isActive
            ? 'bg-secondary font-medium text-foreground'
            : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
        )
      }
    >
      <Icon className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
      <span className="flex-1 text-left">{tab.label}</span>
    </NavLink>
  );
}
