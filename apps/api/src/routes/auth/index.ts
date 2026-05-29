// Composes all /api/auth/* sub-routes.

import { Hono } from 'hono';
import { firstRunRoute } from './first-run';
import { loginRoute } from './login';
import { passkeyRoute } from './passkey';
import { sessionRoute } from './session';
import { stepUpRoute } from './step-up';

export const authRoute = new Hono();

authRoute.route('/first-run', firstRunRoute);
// /password/* and /passkey/auth-* live under loginRoute at the auth root.
authRoute.route('/', loginRoute);
authRoute.route('/passkey', passkeyRoute);
authRoute.route('/step-up', stepUpRoute);
// /session, /refresh, /logout, /logout-all live under sessionRoute at the auth root.
authRoute.route('/', sessionRoute);
