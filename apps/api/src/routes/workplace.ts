import { Hono } from 'hono';
import { env } from '../env';

// Returns the workplace display name only. Zones, jurisdiction, and any
// other workplace metadata are intentionally withheld until a consumer
// in a later milestone needs them. See CLAUDE.md non-negotiable #1.

export const workplaceRoute = new Hono();

workplaceRoute.get('/', (c) => c.json({ displayName: env.WORKPLACE_DISPLAY_NAME }));
