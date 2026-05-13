import { describe, expect, it } from 'vitest';
import { app } from './index';

describe('GET /health', () => {
  it('returns 200 with the expected shape', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(await res.json()).toEqual({ status: 'ok', service: 'ai-proxy' });
  });
});
