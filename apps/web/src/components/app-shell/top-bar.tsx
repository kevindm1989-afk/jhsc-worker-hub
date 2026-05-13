import { Bell, Search, Shield } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { ThemeToggle } from '@/components/theme-toggle';
import { TABS } from '@/lib/tabs';

// Top bar — 56px sticky, backdrop-blurred. Layout differs by viewport:
// mobile shows the brand mark (sidebar is hidden); desktop shows the
// active page title (brand lives in the sidebar).
//
// Visual anchors: app-shell.tsx:151 (positioning), :152 (height), :154-160
// (mobile brand), :161-165 (desktop page title), :167-188 (right cluster).

export function TopBar(): JSX.Element {
  const { pathname } = useLocation();
  const activeTab = TABS.find((t) => pathname === t.path || pathname.startsWith(`${t.path}/`));
  const pageTitle = activeTab?.label ?? '';

  return (
    <header className="sticky top-0 z-20 border-b border-border bg-card/95 backdrop-blur">
      <div className="flex h-14 items-center justify-between px-4 md:px-6">
        {/* Mobile: brand mark inline (no sidebar on mobile) */}
        <div className="flex items-center gap-2 md:hidden">
          <div className="flex h-7 w-7 items-center justify-center rounded bg-primary">
            <Shield className="h-4 w-4 text-primary-foreground" strokeWidth={2.25} />
          </div>
          <div className="text-sm font-semibold tracking-tight text-foreground">
            JHSC Worker Hub
          </div>
        </div>

        {/* Desktop: current page title (brand is in the sidebar) */}
        <div className="hidden items-center gap-2 text-sm md:flex">
          <span className="font-medium text-foreground">{pageTitle}</span>
        </div>

        {/* Right cluster: Search | Theme | Notifications */}
        <div className="flex items-center gap-1">
          <SearchButton />
          <ThemeToggle />
          <NotificationsButton />
        </div>
      </div>
    </header>
  );
}

// Non-functional in Milestone 1.1. Renders chrome only; clicking is a no-op.
function SearchButton(): JSX.Element {
  return (
    <button
      type="button"
      aria-label="Search"
      title="Search — not yet implemented"
      className="flex h-9 items-center gap-2 rounded-md border border-border bg-card px-3 text-sm text-muted-foreground transition-colors hover:border-border hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      <Search className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
      <span className="hidden md:inline">Search or jump to…</span>
      <kbd className="ml-6 hidden rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground md:inline">
        ⌘K
      </kbd>
    </button>
  );
}

// Non-functional in Milestone 1.1. Web Push lands in 1.10.
function NotificationsButton(): JSX.Element {
  return (
    <button
      type="button"
      aria-label="Notifications"
      title="Notifications — not yet implemented"
      className="relative flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      <Bell className="h-[18px] w-[18px]" strokeWidth={2} aria-hidden="true" />
      <span
        className="absolute right-1.5 top-1.5 block h-1.5 w-1.5 rounded-full bg-status-open"
        aria-hidden="true"
      />
    </button>
  );
}
