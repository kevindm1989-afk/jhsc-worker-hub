import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/app-shell/app-shell';
import { ThemeProvider } from './components/theme-provider';
import { AuthProvider } from './auth/auth-context';
import { AuthRouter } from './auth/route-guard';
import { StepUpModal } from './auth/step-up-modal';
import { HazardsView } from './views/hazards-view';
import { InspectionsView } from './views/inspections-view';
import { MinutesView } from './views/minutes-view';
import { MoreView } from './views/more-view';
import { RecommendationsView } from './views/recommendations-view';
import { SecurityView } from './views/security-view';

// App owns all app-level providers (theme, router, auth) so the whole
// tree is renderable as a single unit in tests. main.tsx is just the
// bootstrap.
//
// Default route redirects to /minutes per ARCHITECTURE.md §3 — Minutes
// is the canonical mobile open-the-app surface.
//
// AuthRouter sits between BrowserRouter and AppShell so the
// /setup and /login surfaces render WITHOUT the chrome (no bottom tab
// bar, no skip-link interleaving). Once the user is authenticated,
// AuthRouter renders its children — the existing AppShell + main routes.

export function App(): JSX.Element {
  return (
    <ThemeProvider>
      <BrowserRouter>
        <AuthProvider>
          <AuthRouter>
            <AppShell>
              <Routes>
                <Route index element={<Navigate to="/minutes" replace />} />
                <Route path="/minutes" element={<MinutesView />} />
                <Route path="/hazards" element={<HazardsView />} />
                <Route path="/inspections" element={<InspectionsView />} />
                <Route path="/recommendations" element={<RecommendationsView />} />
                <Route path="/more" element={<MoreView />} />
                <Route path="/account/security" element={<SecurityView />} />
                <Route path="*" element={<Navigate to="/minutes" replace />} />
              </Routes>
            </AppShell>
            {/* Global modal — listens for 401-StepUp responses. */}
            <StepUpModal />
          </AuthRouter>
        </AuthProvider>
      </BrowserRouter>
    </ThemeProvider>
  );
}
