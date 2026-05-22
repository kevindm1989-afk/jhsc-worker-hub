// Typed client for /api/evidence/*.

import type { EvidenceLinkedType, EvidenceMimeType } from '@jhsc/shared-types';

const BASE = '/api/evidence';

export class EvidenceApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown) {
    super(`evidence api ${status}`);
    this.name = 'EvidenceApiError';
    this.status = status;
    this.body = body;
  }
}

async function call<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { 'X-Requested-With': 'jhsc-web' };
  let body: BodyInit | undefined;
  if (init.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(init.json);
  }
  const res = await fetch(`${BASE}${path}`, {
    method: init.method ?? 'GET',
    credentials: 'same-origin',
    headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // leave as text
    }
    throw new EvidenceApiError(res.status, parsed);
  }
  return (await res.json()) as T;
}

export interface UploadUrlResponse {
  readonly uploadUrl: string;
  readonly storageKey: string;
  readonly expiresInSeconds: number;
  readonly workplaceKeyId: string;
  readonly workplacePublicKeyB64: string;
}

export interface EvidenceItem {
  readonly id: string;
  readonly mimeType: EvidenceMimeType;
  readonly byteSize: number;
  readonly capturedAt: string | null;
  readonly gpsLatitude: number | null;
  readonly gpsLongitude: number | null;
  readonly gpsAccuracyM: number | null;
  readonly uploadedAt: string;
  readonly uploadedByUserId: string;
  readonly plaintextSha256: string;
}

export interface FinalizeBody {
  readonly storageKey: string;
  readonly ciphertextSha256: string;
  readonly sealedDekB64: string;
  readonly plaintextSha256: string;
  readonly workplaceKeyId: string;
  readonly mimeType: EvidenceMimeType;
  readonly byteSize: number;
  readonly capturedAt?: string;
  readonly gpsLatitude?: number;
  readonly gpsLongitude?: number;
  readonly gpsAccuracyM?: number;
  readonly linkedType: EvidenceLinkedType;
  readonly linkedId: string;
}

export const evidenceApi = {
  uploadUrl: (mimeType: EvidenceMimeType, byteSizeEstimate: number): Promise<UploadUrlResponse> =>
    call('/upload-url', { method: 'POST', json: { mimeType, byteSizeEstimate } }),
  putToTigris: async (
    uploadUrl: string,
    ciphertext: Uint8Array,
    mimeType: string,
  ): Promise<void> => {
    const res = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': mimeType, 'content-length': String(ciphertext.length) },
      // ArrayBuffer transfer to detach the libsodium-owned memory.
      body: ciphertext.slice().buffer,
    });
    if (!res.ok) {
      throw new EvidenceApiError(res.status, await res.text().catch(() => ''));
    }
  },
  finalize: (
    body: FinalizeBody,
  ): Promise<{
    id: string;
    linkedType: EvidenceLinkedType;
    linkedId: string;
    uploadedAt: string;
  }> => call('', { method: 'POST', json: body }),
  list: (
    linkedType: EvidenceLinkedType,
    linkedId: string,
  ): Promise<{ items: ReadonlyArray<EvidenceItem> }> =>
    call(`?linkedType=${encodeURIComponent(linkedType)}&linkedId=${encodeURIComponent(linkedId)}`),
  decryptUrl: (id: string): string => `${BASE}/${encodeURIComponent(id)}/decrypt`,
};
