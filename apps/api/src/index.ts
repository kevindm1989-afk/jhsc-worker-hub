import { Hono } from 'hono';
import { env } from './env';
import { authRoute } from './routes/auth';
import { healthRoute } from './routes/health';
import { workplaceRoute } from './routes/workplace';

export const app = new Hono();

app.route('/health', healthRoute);
app.route('/api/auth', authRoute);
app.route('/api/workplace', workplaceRoute);

// Bun picks up the default export and calls Bun.serve under the hood. Tests
// import the named `app` export instead and never trigger the server.
export default {
  fetch: app.fetch,
  port: env.API_PORT,
};
