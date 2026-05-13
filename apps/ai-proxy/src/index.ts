import { Hono } from 'hono';
import { env } from './env';
import { healthRoute } from './routes/health';

export const app = new Hono();

app.route('/health', healthRoute);

// Bun picks up the default export and calls Bun.serve under the hood. Tests
// import the named `app` export instead and never trigger the server.
export default {
  fetch: app.fetch,
  port: env.AI_PROXY_PORT,
};
