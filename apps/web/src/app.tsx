import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/app-shell/app-shell';
import { ThemeProvider } from './components/theme-provider';
import { AuthProvider } from './auth/auth-context';
import { AuthRouter } from './auth/route-guard';
import { StepUpModal } from './auth/step-up-modal';
import { ActionItemDetailView } from './views/action-item-detail-view';
import { CaptureView } from './views/capture-view';
import { ActionItemNewView } from './views/action-item-new-view';
import { ActionItemsView } from './views/action-items-view';
import { ExcelImportDetailView } from './views/excel-import-detail-view';
import { ExcelImportsView } from './views/excel-imports-view';
import { NewExcelImportView } from './views/new-excel-import-view';
import { HazardDetailView } from './views/hazard-detail-view';
import { HazardNewView } from './views/hazard-new-view';
import { HazardsView } from './views/hazards-view';
import { FindingDetailView } from './views/finding-detail-view';
import { InspectionDetailView } from './views/inspection-detail-view';
import { InspectionsExportsView } from './views/inspections-exports-view';
import { InspectionsView } from './views/inspections-view';
import { NewInspectionView } from './views/new-inspection-view';
import { NewTemplateView } from './views/new-template-view';
import { TemplatesView } from './views/templates-view';
import { LegalView } from './views/legal-view';
import { MinutesView } from './views/minutes-view';
import { MoreView } from './views/more-view';
import { NewRecommendationView } from './views/new-recommendation-view';
import { RecommendationDetailView } from './views/recommendation-detail-view';
import { RecommendationEditView } from './views/recommendation-edit-view';
import { RecommendationsView } from './views/recommendations-view';
import { RecommendationsExportsView } from './views/recommendations-exports-view';
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
                <Route path="/hazards/new" element={<HazardNewView />} />
                <Route path="/hazards/:id" element={<HazardDetailView />} />
                <Route path="/action-items" element={<ActionItemsView />} />
                <Route path="/action-items/new" element={<ActionItemNewView />} />
                <Route path="/action-items/:id" element={<ActionItemDetailView />} />
                <Route path="/capture" element={<CaptureView />} />
                <Route path="/inspections" element={<InspectionsView />} />
                <Route path="/inspections/new" element={<NewInspectionView />} />
                <Route path="/inspections/exports" element={<InspectionsExportsView />} />
                <Route path="/inspections/:id" element={<InspectionDetailView />} />
                <Route
                  path="/inspections/:id/findings/:findingId"
                  element={<FindingDetailView />}
                />
                <Route path="/inspection-templates" element={<TemplatesView />} />
                <Route path="/inspection-templates/new" element={<NewTemplateView />} />
                <Route path="/recommendations" element={<RecommendationsView />} />
                <Route path="/recommendations/new" element={<NewRecommendationView />} />
                <Route path="/recommendations/exports" element={<RecommendationsExportsView />} />
                <Route path="/recommendations/:id" element={<RecommendationDetailView />} />
                <Route path="/recommendations/:id/edit" element={<RecommendationEditView />} />
                <Route path="/excel-imports" element={<ExcelImportsView />} />
                <Route path="/excel-imports/new" element={<NewExcelImportView />} />
                <Route path="/excel-imports/:id" element={<ExcelImportDetailView />} />
                <Route path="/more" element={<MoreView />} />
                <Route path="/legal" element={<LegalView />} />
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
