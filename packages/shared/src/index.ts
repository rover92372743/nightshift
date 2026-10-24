export * from './compute.js';
export * from './node-client.js';

// Shared types and the receipt canonicalisation routine.
//
// Both the API and the browser import from here, so anything in this file has
// to run in Node and in a browser without polyfills. Keep it dependency free.

export type NodeClass = 'browser' | 'native' | 'cloud' | 'external';

export type Workload = 'llm' | 'compute';

export type JobStatus =
  | 'queued'     // accepted, waiting for a node
  | 'assigned'   // leased to a node, not yet started
  | 'running'    // node reported start
  | 'done'       // completed, receipt issued
  | 'failed'     // node reported failure, or lease expired too many times
  | 'cancelled'; // requester cancelled before assignment

export interface NodeCapabilities {
  workloads: Workload[];
  /** Model identifiers the node can serve, e.g. "qwen2.5-0.5b-instruct". */
  models: string[];
  maxPromptChars: number;
  maxOutputTokens: number;
  /** Price in micro-credits per 1k output tokens (llm) or per work unit (compute). */
  pricePer1k: number;
  /** Rough throughput the node claims, used as a tie-breaker. */
  tokensPerSec?: number;
  /** What the node is running on. Self-reported; the benchmark on registration is what pricing trusts. */
  hardware?: {
    gpu?: string;       // e.g. "NVIDIA GeForce RTX 4070"
    vramGb?: number;
    tier?: HardwareTier;
  };
}

/** Coarse hardware classes used for suggested pricing and the earnings table. */
export type HardwareTier = 'cpu' | 'gpu-8' | 'gpu-16' | 'gpu-24' | 'gpu-48' | 'gpu-80';

export const TIER_LABEL: Record<HardwareTier, string> = {
  cpu: 'CPU only',
  'gpu-8': 'GPU, up to 8 GB',
  'gpu-16': 'GPU, 12–16 GB',
  'gpu-24': 'GPU, 20–24 GB',
  'gpu-48': 'GPU, 32–48 GB',
  'gpu-80': 'GPU, 80 GB+',
};

export function tierForVram(vramGb: number | undefined): HardwareTier {
  if (!vramGb || vramGb < 4) return 'cpu';
  if (vramGb <= 8) return 'gpu-8';
  if (vramGb <= 16) return 'gpu-16';
  if (vramGb <= 24) return 'gpu-24';
  if (vramGb <= 48) return 'gpu-48';
  return 'gpu-80';
}

export interface NodeRecord {
  id: string;
  class: NodeClass;
  label: string;
  publicKey: string; // base64url ed25519
  capabilities: NodeCapabilities;
  status: 'online' | 'busy' | 'offline';
  lastSeen: number;
  createdAt: number;
  /** Lifetime counters, kept on the node row so the earn page is one query. */
  jobsDone: number;
  jobsFailed: number;
  unitsVerified: number;
  earnedMicro: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface JobInput {
  workload: Workload;
  model: string;
  messages?: ChatMessage[];      // llm
  maxOutputTokens?: number;      // llm
  temperature?: number;          // llm
  seed?: number;                 // compute
  rounds?: number;               // compute
}

export interface JobOutput {
  text?: string;                 // llm
  digest?: string;               // compute: hex sha-256 of final state
  outputTokens: number;
  units: number;
  durationMs: number;
}

export interface JobRecord {
  id: string;
  status: JobStatus;
  requesterId: string;
  input: JobInput;
  inputHash: string;
  output?: JobOutput;
  nodeId?: string;
  leaseExpiresAt?: number;
  attempts: number;
  priceMicro: number;            // quoted at enqueue time
  costMicro?: number;            // settled at completion
  createdAt: number;
  assignedAt?: number;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
}

/**
 * The receipt is the thing a requester can hand to someone else and have them
 * check without talking to us. Everything that matters is in `body`, and the
 * two signatures cover the canonical JSON of that body.
 */
export interface ReceiptBody {
  v: 1;
  jobId: string;
  nodeId: string;
  nodeClass: NodeClass;
  workload: Workload;
  model: string;
  inputHash: string;
  outputHash: string;
  outputTokens: number;
  units: number;
  startedAt: number;
  finishedAt: number;
  costMicro: number;
}

export interface Receipt {
  id: string;
  body: ReceiptBody;
  /** Node's signature over canonical(body). */
  nodeSig: string;
  /** Router's countersignature over canonical(body) + nodeSig. Proves we saw and accepted it. */
  routerSig: string;
  routerKey: string;
  nodeKey: string;
}

export interface LedgerEntry {
  id: string;
  accountId: string;
  deltaMicro: number;
  kind: 'grant' | 'charge' | 'earn' | 'payout' | 'refund';
  ref?: string;
  createdAt: number;
}

export interface NetworkStats {
  nodesOnline: number;
  /** Every node that has ever registered with this router. Real count, not a target. */
  nodesRegistered: number;
  nodesByClass: Record<NodeClass, number>;
  jobsQueued: number;
  jobsRunning: number;
  jobsDone: number;
  jobsFailed: number;
  unitsVerified: number;
  successRate: number;
  /** Rolling 1h p50/p95 queue-to-done latency, ms. */
  p50Ms: number;
  p95Ms: number;
  /** Cheapest current llm quote in micro-credits per 1k tokens, or null if no node. */
  floorPricePer1k: number | null;
}

/** What goes down the live WebSocket. */
export type LiveEvent =
  | { t: 'hello'; stats: NetworkStats; nodes: PublicNode[] }
  | { t: 'stats'; stats: NetworkStats }
  | { t: 'node.up'; node: PublicNode }
  | { t: 'node.down'; nodeId: string }
  | { t: 'node.busy'; nodeId: string; busy: boolean }
  | { t: 'job.queued'; jobId: string; workload: Workload; model: string }
  | { t: 'job.assigned'; jobId: string; nodeId: string }
  | { t: 'job.done'; jobId: string; nodeId: string; units: number; durationMs: number; costMicro: number }
  | { t: 'job.failed'; jobId: string; nodeId?: string; reason: string };

/** Node fields safe to broadcast to anyone watching the map. */
export type PublicNode = Pick<NodeRecord, 'id' | 'class' | 'label' | 'status' | 'capabilities' | 'jobsDone'>;

// ---------------------------------------------------------------------------
// Canonical JSON. Keys sorted, no whitespace, numbers as-is. This is what gets
// signed, so if you change it you invalidate every receipt in the wild.

export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
}

export const MICRO = 1_000_000; // micro-credits per credit

export function fmtCredits(micro: number, digits = 2): string {
  return (micro / MICRO).toFixed(digits);
}

export const PRICE_FLOOR_PER_1K = 200;      // 0.0002 cr
export const FREE_GRANT_MICRO = 50_000;     // 0.05 cr per anonymous session
/** One credit is one US dollar for business pricing and payouts. */
export const USD_PER_CREDIT = 1;
export const PAYOUT_MIN_MICRO = 50 * MICRO;  // $50 before SOL or USDC can be requested
export const LEASE_MS = 90_000;
export const HEARTBEAT_MS = 10_000;
export const OFFLINE_AFTER_MS = 35_000;
export const MAX_ATTEMPTS = 3;
