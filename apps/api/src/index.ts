import { Hono } from 'hono';
import { env } from './env';
import { csrfHeaderGuard, securityHeaders } from './middleware/security';
import { actionItemsRoute } from './routes/action-items';
import { authRoute } from './routes/auth';
import { evidenceRoute } from './routes/evidence';
import { excelImportsRoute } from './routes/excel-imports';
import { hazardsRoute } from './routes/hazards';
import { healthRoute } from './routes/health';
import { inspectionsRoute, inspectionTemplatesRoute } from './routes/inspections';
import { legalRoute } from './routes/legal';
import { recommendationsRoute } from './routes/recommendations';
import { workplaceRoute } from './routes/workplace';

export const app = new Hono();

// Root middlewares — every request passes through these before any route
// matches. securityHeaders applies CSP/HSTS/etc. csrfHeaderGuard rejects
// mutating requests without X-Requested-With (security-reviewer F1, F7).
app.use('*', securityHeaders);
app.use('*', csrfHeaderGuard());

app.route('/health', healthRoute);
app.route('/api/auth', authRoute);
app.route('/api/workplace', workplaceRoute);
app.route('/api/legal', legalRoute);
app.route('/api/hazards', hazardsRoute);
app.route('/api/action-items', actionItemsRoute);
app.route('/api/evidence', evidenceRoute);
app.route('/api/inspection-templates', inspectionTemplatesRoute);
app.route('/api/inspections', inspectionsRoute);
app.route('/api/recommendations', recommendationsRoute);
app.route('/api/excel-imports', excelImportsRoute);

// Bun picks up the default export and calls Bun.serve under the hood. Tests
// import the named `app` export instead and never trigger the server.
export default {
  fetch: app.fetch,
  port: env.API_PORT,
};
