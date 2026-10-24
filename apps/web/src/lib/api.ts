import type { JobRecord, LedgerEntry, NetworkStats, PublicNode, Receipt } from '@docket/shared';

export const API_BASE: string = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? '';

export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const msg = (data as { error?: { message?: string } })?.error?.message ?? `${res.status} ${res.statusText}`;
    throw new ApiError(res.status, msg, data);
  }
  return data as T;
}

export const api = {
  health: () => call<{ ok: boolean; routerKey: string }>('/health'),
  network: () => call<{ stats: NetworkStats; routerKey: string }>('/v1/network'),
  nodes: () => call<{ nodes: PublicNode[] }>('/v1/nodes'),
  me: () => call<{ accountId: string; balanceMicro: number; ledger: LedgerEntry[] }>('/v1/me'),
  createKey: (label: string) => call<{ accountId: string; apiKey: string }>('/v1/keys', { method: 'POST', body: JSON.stringify({ label }) }),
  chat: (body: { model: string; messages: { role: string; content: string }[]; max_tokens: number; temperature?: number }) =>
    call<ChatResponse>('/v1/chat/completions', { method: 'POST', body: JSON.stringify(body) }),
  job: (id: string) => call<JobRecord & { receipt?: Receipt }>(`/v1/jobs/${id}`),
  jobs: () => call<{ jobs: JobRecord[] }>('/v1/jobs'),
  submitJob: (body: Record<string, unknown>) => call<JobRecord>('/v1/jobs', { method: 'POST', body: JSON.stringify(body) }),
  latestReceipts: () => call<{ receipts: Receipt[] }>('/v1/receipts'),
  receipt: (id: string) => call<{ receipt: Receipt; valid: Verdict }>(`/v1/receipts/${id}`),
  verify: (receipt: Receipt) => call<Verdict>('/v1/receipts/verify', { method: 'POST', body: JSON.stringify({ receipt }) }),
};

export interface Verdict {
  valid: boolean;
  nodeSignature: boolean;
  routerSignature: boolean;
  routerIsThisRouter: boolean;
  canonical: string;
}

export interface ChatResponse {
  id: string;
  model: string;
  choices: { message: { role: string; content: string }; finish_reason: string }[];
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  docket: { job_id: string; node_id?: string; receipt_id?: string; cost_micro?: number; duration_ms: number };
}

export function wsUrl(): string {
  const base = API_BASE || window.location.origin;
  return base.replace(/^http/, 'ws') + '/v1/network/live';
}
