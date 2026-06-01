// Unit tests for apps/api/src/evidence/tigris.ts.
//
// These tests stand alone — no live Tigris, no DB. The buildPutObjectCommand
// helper is exported so we can assert the SSE parameter is set on every
// PUT (priv-F1 / T-I40 close-out).

import { describe, expect, it } from 'vitest';
import { buildPutObjectCommand } from './tigris';

describe('buildPutObjectCommand (priv-F1 / T-I40)', () => {
  it('sets ServerSideEncryption: AES256 on every PutObjectCommand', () => {
    const cmd = buildPutObjectCommand('test-bucket', {
      storageKey: 'exports/abc-123/inspection-abc-123.pdf',
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]), // %PDF-
      mimeType: 'application/pdf',
    });
    // AWS SDK v3: parameters live on `cmd.input`.
    expect(cmd.input.ServerSideEncryption).toBe('AES256');
    expect(cmd.input.Bucket).toBe('test-bucket');
    expect(cmd.input.Key).toBe('exports/abc-123/inspection-abc-123.pdf');
    expect(cmd.input.ContentType).toBe('application/pdf');
    expect(cmd.input.ContentLength).toBe(5);
  });

  it('propagates the bucket from the caller', () => {
    const a = buildPutObjectCommand('bucket-a', {
      storageKey: 'k',
      bytes: new Uint8Array(),
      mimeType: 'application/octet-stream',
    });
    const b = buildPutObjectCommand('bucket-b', {
      storageKey: 'k',
      bytes: new Uint8Array(),
      mimeType: 'application/octet-stream',
    });
    expect(a.input.Bucket).toBe('bucket-a');
    expect(b.input.Bucket).toBe('bucket-b');
    // SSE still applied independently of bucket.
    expect(a.input.ServerSideEncryption).toBe('AES256');
    expect(b.input.ServerSideEncryption).toBe('AES256');
  });
});
