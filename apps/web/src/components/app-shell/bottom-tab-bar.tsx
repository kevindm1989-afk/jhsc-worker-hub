import { NavLink } from 'react-router-dom';
import { TABS, type TabDefinition } from '@/lib/tabs';
import { cn } from '@/lib/utils';

// Mobile bottom tab bar — 64px, fixed bottom, hidden at md and above.
// Visual anchors: app-shell.tsx:212-234.

export function BottomTabBar(): JSX.Element {
  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-30 border-t border-border bg-card md:hidden"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      aria-label="Primary"
    >
      <div className="grid h-16 grid-cols-5">
        {TABS.map((tab) => (
          <TabBarItem key={tab.id} tab={tab} />
        ))}
      </div>
    </nav>
  );
}

function TabBarItem({ tab }: { tab: TabDefinition }): JSX.Element {
  const Icon = tab.icon;
  return (
    <NavLink
      to={tab.path}
      className={({ isActive }) =>
        cn(
          'flex flex-col items-center justify-center gap-1 transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
          isActive ? 'text-foreground' : 'text-muted-foreground',
        )
      }
    >
      {({ isActive }) => (
        <>
          <Icon className="h-5 w-5" strokeWidth={isActive ? 2.25 : 2} aria-hidden="true" />
          <span
            className={cn('text-[10px] tracking-tight', isActive ? 'font-semibold' : 'font-medium')}
          >
            {tab.shortLabel}
          </span>
        </>
      )}
    </NavLink>
  );
}
