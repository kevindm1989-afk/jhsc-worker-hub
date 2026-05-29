// Typed API client for /api/auth/*.
//
// All requests carry `credentials: 'include'` so the __Host-access and
// __Secure-refresh cookies ride automatically. Mutating endpoints set
// the `X-Requested-With: jhsc-web` header — the API checks it as a
// supplementary CSRF guard alongside SameSite=Strict cookies (per
// SECURITY.md §2.1 T-A16).
//
// Auto-refresh: when any call gets 401 with the body kind
// `session_expired`, we try a single /refresh round-trip and retry the
// original request before giving up. A 401 with `step_up_required`
// surfaces the action so a UI listener can open the step-up modal.

const API_BASE = '/api';

export class ApiError extends Error {
  readonly status: number;
  readonly kind: string | undefined;
  readonly payload: unknown;

  constructor(status: number, payload: unknown) {
    const kind = isErrorPayload(payload) ? payload.error : undefined;
    super(kind ? `api ${status}: ${kind}` : `api ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.kind = kind;
    this.payload = payload;
  }
}

interface ErrorPayload {
  readonly error: string;
}

function isErrorPayload(v: unknown): v is ErrorPayload {
  return (
    typeof v === 'object' && v !== null && typeof (v as { error?: unknown }).error === 'string'
  );
}

interface FetchOptions {
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly body?: unknown;
  readonly autoRefresh?: boolean;
}

async function call<T>(path: string, opts: FetchOptions = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = { 'X-Requested-With': 'jhsc-web' };
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const init: RequestInit = { method, credentials: 'include', headers };
  if (body !== undefined) init.body = body;
  const res = await fetch(`${API_BASE}${path}`, init);

  // Surface step-up requirements regardless of method.
  if (res.status === 401) {
    const payload = await safeJson(res);
    if (isErrorPayload(payload) && payload.error === 'step_up_required') {
      stepUpEmitter.dispatch((payload as { action?: string }).action ?? 'unknown');
      throw new ApiError(401, payload);
    }
    // Auto-refresh once if the cookie is just stale.
    if (
      (opts.autoRefresh ?? true) &&
      isErrorPayload(payload) &&
      payload.error === 'unauthorized' &&
      path !== '/auth/refresh'
    ) {
      try {
        await call('/auth/refresh', { method: 'POST', autoRefresh: false });
        return call<T>(path, { ...opts, autoRefresh: false });
      } catch {
        throw new ApiError(401, payload);
      }
    }
    throw new ApiError(401, payload);
  }
  if (!res.ok) {
    throw new ApiError(res.status, await safeJson(res));
  }
  // 204 No Content fast path — some logout/revoke endpoints may use it.
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Step-up event bus — a tiny global pub/sub so any API call can wake the
// step-up modal without prop-drilling.
// ---------------------------------------------------------------------------

type StepUpListener = (action: string) => void;

class StepUpEmitter {
  private listeners = new Set<StepUpListener>();
  subscribe(fn: StepUpListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  dispatch(action: string): void {
    for (const fn of this.listeners) fn(action);
  }
}

export const stepUpEmitter = new StepUpEmitter();

// ---------------------------------------------------------------------------
// Typed endpoints
// ---------------------------------------------------------------------------

export interface FirstRunStatus {
  readonly completed: boolean;
}

export interface SetupBody {
  readonly email: string;
  readonly password: string;
  readonly displayName: string;
}

export interface SetupResult {
  readonly provisioning: string;
  readonly totpUri: string;
  readonly totpSecretB32: string;
}

export interface ConfirmBody {
  readonly provisioning: string;
  readonly totpCode: string;
}

export interface SessionInfo {
  readonly userId: string;
  readonly displayName: string | null;
  readonly sessionId: string;
  readonly stepUp: { readonly active: boolean; readonly until: string | null };
}

export interface PasswordLoginResult {
  readonly stage: 'totp_required';
  readonly pending: string;
}

export interface PasskeySummary {
  readonly id: string;
  readonly nickname: string;
  readonly transports: ReadonlyArray<string>;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
}

export const api = {
  firstRun: {
    status: () => call<FirstRunStatus>('/auth/first-run/status'),
    setup: (body: SetupBody) =>
      call<SetupResult>('/auth/first-run/setup', { method: 'POST', body }),
    confirm: (body: ConfirmBody) =>
      call<{ userId: string; sessionId: string }>('/auth/first-run/confirm', {
        method: 'POST',
        body,
      }),
  },
  session: {
    current: () => call<SessionInfo>('/auth/session'),
    logout: () => call<{ ok: boolean }>('/auth/logout', { method: 'POST' }),
    logoutAll: () => call<{ ok: boolean }>('/auth/logout-all', { method: 'POST' }),
    refresh: () => call<{ sessionId: string }>('/auth/refresh', { method: 'POST' }),
  },
  passwordLogin: {
    start: (body: { email: string; password: string }) =>
      call<PasswordLoginResult>('/auth/password/login', { method: 'POST', body }),
    totp: (body: { pending: string; totpCode: string }) =>
      call<{ userId: string; sessionId: string }>('/auth/password/totp', {
        method: 'POST',
        body,
      }),
    recovery: (body: { pending: string; recoveryCode: string }) =>
      call<{ userId: string; sessionId: string }>('/auth/password/recovery', {
        method: 'POST',
        body,
      }),
  },
  passkey: {
    authOptions: (body: { email?: string }) =>
      call<unknown>('/auth/passkey/auth-options', { method: 'POST', body }),
    authVerify: (response: unknown) =>
      call<{ userId: string; sessionId: string }>('/auth/passkey/auth-verify', {
        method: 'POST',
        body: response,
      }),
    registerOptions: () => call<unknown>('/auth/passkey/register-options', { method: 'POST' }),
    registerVerify: (response: unknown) =>
      call<{ credentialId: string }>('/auth/passkey/register-verify', {
        method: 'POST',
        body: response,
      }),
    list: () => call<{ passkeys: ReadonlyArray<PasskeySummary> }>('/auth/passkey'),
    rename: (id: string, nickname: string) =>
      call<{ ok: boolean }>(`/auth/passkey/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: { nickname },
      }),
    remove: (id: string) =>
      call<{ ok: boolean }>(`/auth/passkey/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  },
  stepUp: {
    passkeyOptions: () => call<unknown>('/auth/step-up/passkey/options', { method: 'POST' }),
    passkeyVerify: (response: unknown) =>
      call<{ stepUp: { active: boolean; until: string | null } }>('/auth/step-up/passkey/verify', {
        method: 'POST',
        body: response,
      }),
    totp: (body: { totpCode: string }) =>
      call<{ stepUp: { active: boolean; until: string | null } }>('/auth/step-up/totp', {
        method: 'POST',
        body,
      }),
  },
};
