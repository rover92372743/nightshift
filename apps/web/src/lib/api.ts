import type { JobRecord, LedgerEntry, NetworkStats, PublicNode, Receipt } from '@nightshift/shared';

export const API_BASE: string = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? '';

export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
  }
}

// Console sign-in. A business key goes in Authorization; the operator key in
// x-admin-key. Both live in sessionStorage so they're gone when the tab closes.
const KEY_SLOT = 'nightshift.console.key';
const ADMIN_SLOT = 'nightshift.console.admin';
function slot(name: string): string | null {
  try {
    return sessionStorage.getItem(name);
  } catch {
    return null;
  }
}
function setSlot(name: string, v: string | null): void {
  try {
    v ? sessionStorage.setItem(name, v) : sessionStorage.removeItem(name);
  } catch {
    /* private mode */
  }
}
export const session = {
  key: () => slot(KEY_SLOT),
  setKey: (k: string | null) => setSlot(KEY_SLOT, k),
  admin: () => slot(ADMIN_SLOT),
  setAdmin: (k: string | null) => setSlot(ADMIN_SLOT, k),
};

function authHeaders(): Record<string, string> {
  const out: Record<string, string> = {};
  const k = session.key();
  const a = session.admin();
  if (k) out.authorization = `Bearer ${k}`;
  if (a) out['x-admin-key'] = a;
  return out;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    ...init,
    headers: { 'content-type': 'application/json', ...authHeaders(), ...(init.headers ?? {}) },
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
  me: () => call<{ accountId: string; kind?: string; label?: string | null; balanceMicro: number; ledger: LedgerEntry[] }>('/v1/me'),
  access: (body: { company: string; email: string; need: string }) => call<{ ok: true }>('/v1/access', { method: 'POST', body: JSON.stringify(body) }),
  submitBatch: (items: Record<string, unknown>[], label?: string) => call<{ id: string; total: number; jobIds: string[] }>('/v1/batches', { method: 'POST', body: JSON.stringify({ items, label }) }),
  batches: () => call<{ batches: BatchSummary[] }>('/v1/batches'),
  batch: (id: string) => call<BatchSummary>(`/v1/batches/${id}`),
  cancelBatch: (id: string) => call<{ cancelled: number; refundedMicro: number }>(`/v1/batches/${id}/cancel`, { method: 'POST', body: '{}' }),
  cancelQueued: (workload?: 'llm' | 'compute') => call<{ cancelled: number; refundedMicro: number }>('/v1/jobs/cancel-queued', { method: 'POST', body: JSON.stringify({ workload }) }),
  batchResults: (id: string) => call<{ batch: BatchSummary; items: BatchItem[] }>(`/v1/batches/${id}/results`),
  job: (id: string) => call<JobRecord & { receipt?: Receipt }>(`/v1/jobs/${id}`),
  jobs: () => call<{ jobs: JobRecord[] }>('/v1/jobs'),
  submitJob: (body: Record<string, unknown>) => call<JobRecord>('/v1/jobs', { method: 'POST', body: JSON.stringify(body) }),
  quote: (body: { company: string; email: string; need: string }) => call<{ ok: true }>('/v1/quotes', { method: 'POST', body: JSON.stringify(body) }),
  latestReceipts: () => call<{ receipts: Receipt[] }>('/v1/receipts'),
  receipt: (id: string) => call<{ receipt: Receipt; valid: Verdict }>(`/v1/receipts/${id}`),
  verify: (receipt: Receipt) => call<Verdict>('/v1/receipts/verify', { method: 'POST', body: JSON.stringify({ receipt }) }),
  admin: {
    me: () => call<{ admin: true; router: string }>('/v1/admin/me'),
    accounts: () => call<{ accounts: AdminAccount[] }>('/v1/admin/accounts'),
    keys: (label: string, credits: number) => call<{ accountId: string; apiKey: string; label: string; balanceMicro: number }>('/v1/admin/keys', { method: 'POST', body: JSON.stringify({ label, credits }) }),
    grant: (accountId: string, credits: number, note?: string) => call<{ entry: LedgerEntry; balanceMicro: number }>('/v1/admin/grant', { method: 'POST', body: JSON.stringify({ accountId, credits, note }) }),
    quotes: () => call<{ quotes: { id: string; company: string; email: string; need: string; createdAt: number }[] }>('/v1/admin/quotes'),
    jobs: () => call<{ jobs: JobRecord[] }>('/v1/admin/jobs'),
    queue: () => call<{ queue: { workload: string; model: string; status: string; n: number; heldMicro: number; oldest: number }[] }>('/v1/admin/queue'),
    purge: (workload?: 'llm' | 'compute', batchId?: string) => call<{ cancelled: number; refundedMicro: number }>('/v1/admin/queue/cancel', { method: 'POST', body: JSON.stringify({ workload, batchId }) }),
    payouts: () => call<{ payouts: PayoutReview[] }>('/v1/admin/payouts'),
    approvePayout: (id: string, txRef: string, note?: string) => call<{ payout: PayoutReview }>(`/v1/admin/payouts/${id}/approve`, { method: 'POST', body: JSON.stringify({ txRef, note }) }),
    rejectPayout: (id: string, reason?: string) => call<{ payout: PayoutReview }>(`/v1/admin/payouts/${id}/reject`, { method: 'POST', body: JSON.stringify({ reason }) }),
  },
};

export interface BatchSummary {
  id: string;
  label: string | null;
  total: number;
  createdAt: number;
  counts: Record<'queued' | 'assigned' | 'running' | 'done' | 'failed' | 'cancelled', number>;
  costMicro: number;
  heldMicro: number;
}
export interface BatchItem {
  index: number;
  jobId: string;
  status: string;
  prompt?: string;
  rounds?: number;
  output?: string;
  units?: number;
  durationMs?: number;
  costMicro?: number;
  receiptId?: string;
  error?: string;
}

export interface PayoutReview {
  id: string;
  accountId: string;
  amountMicro: number;
  rail: 'usdc';
  address: string;
  status: 'pending' | 'sent' | 'rejected';
  txRef?: string;
  note?: string;
  createdAt: number;
  settledAt?: number;
  nodeId: string;
  nodeLabel: string;
  balanceMicro: number;
  earnedMicro: number;
  jobsDone: number;
  priorRequests: number;
  addressSharedWith: number;
}

export interface AdminAccount {
  id: string;
  kind: string;
  label: string | null;
  balanceMicro: number;
  createdAt: number;
}

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
  nightshift: { job_id: string; node_id?: string; receipt_id?: string; cost_micro?: number; duration_ms: number };
}

export function wsUrl(): string {
  const base = API_BASE || window.location.origin;
  return base.replace(/^http/, 'ws') + '/v1/network/live';
}
