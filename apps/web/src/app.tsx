import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/app-shell/app-shell';
import { ThemeProvider } from './components/theme-provider';
import { HazardsView } from './views/hazards-view';
import { InspectionsView } from './views/inspections-view';
import { MinutesView } from './views/minutes-view';
import { MoreView } from './views/more-view';
import { RecommendationsView } from './views/recommendations-view';

// App owns all app-level providers (theme, router) so the whole tree is
// renderable as a single unit in tests. main.tsx is just the bootstrap.
//
// Default route redirects to /minutes per ARCHITECTURE.md §3 — Minutes is
// the canonical mobile open-the-app surface.

export function App(): JSX.Element {
  return (
    <ThemeProvider>
      <BrowserRouter>
        <AppShell>
          <Routes>
            <Route index element={<Navigate to="/minutes" replace />} />
            <Route path="/minutes" element={<MinutesView />} />
            <Route path="/hazards" element={<HazardsView />} />
            <Route path="/inspections" element={<InspectionsView />} />
            <Route path="/recommendations" element={<RecommendationsView />} />
            <Route path="/more" element={<MoreView />} />
            <Route path="*" element={<Navigate to="/minutes" replace />} />
          </Routes>
        </AppShell>
      </BrowserRouter>
    </ThemeProvider>
  );
}
