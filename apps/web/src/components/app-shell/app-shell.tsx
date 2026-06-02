import { type ReactNode } from 'react';
import { BottomTabBar } from './bottom-tab-bar';
import { DesktopSidebar } from './desktop-sidebar';
import { TopBar } from './top-bar';
import { PwaInstallPrompt } from '@/sync/components/pwa-install-prompt';

// App shell — top-level chrome. CSS-only responsive switch via Tailwind:
// the sidebar is hidden below md, the bottom tab bar is hidden at md+.
// Both elements live in the DOM at all sizes so no JS-driven layout flash
// occurs on initial render.
//
// Skip-to-content anchor lives at the very top of the tab order per CLAUDE.md
// WCAG 2.2 AA baseline.

export function AppShell({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="min-h-screen bg-background text-foreground antialiased">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-card focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-foreground focus:shadow-lg focus:outline-none focus:ring-2 focus:ring-ring"
      >
        Skip to main content
      </a>

      <div className="flex min-h-screen">
        <DesktopSidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar />
          <main
            id="main-content"
            tabIndex={-1}
            className="flex-1 overflow-y-auto pb-20 focus:outline-none md:pb-6"
          >
            {children}
          </main>
        </div>
      </div>

      <BottomTabBar />

      {/* PWA install affordance (S3) — self-mounts as a small banner when
       * the rep has shown engagement signals. T-S37: never auto-fires
       * the native install; renders a tap target that calls the
       * cached beforeinstallprompt event on Android, or surfaces the
       * iOS Share-sheet instructions modal. */}
      <PwaInstallPrompt mode="auto" />
    </div>
  );
}
