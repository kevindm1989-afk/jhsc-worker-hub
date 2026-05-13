import { describe, expect, it } from 'vitest';
import { app } from './index';

describe('GET /health', () => {
  it('returns 200 with the expected shape', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(await res.json()).toEqual({ status: 'ok', service: 'api' });
  });
});

describe('GET /api/workplace', () => {
  it('returns 200 with displayName only', async () => {
    const res = await app.request('/api/workplace');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['displayName']);
    expect(typeof body.displayName).toBe('string');
  });
});
