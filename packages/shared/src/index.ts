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
  /** Price in micro-credits per 1k output tokens (llm) or per 1k work units (compute). */
  pricePer1k: number;
  /** Price in micro-credits per hour of node time, for time-billed jobs. Defaults from the hardware tier. */
  pricePerHour?: number;
  /** Rough throughput the node claims, used as a tie-breaker. */
  tokensPerSec?: number;
  /** What the node is running on. Self-reported; the benchmark on registration is what pricing trusts. */
  hardware?: {
    gpu?: string;       // e.g. "NVIDIA GeForce RTX 4070"
    vramGb?: number;
    tier?: HardwareTier;
  };
  /**
   * Coarse location, opt-in: one of the REGIONS keys (a metro area, nothing
   * finer). It only places the node on the public globe. Never an IP, city
   * block or address; the router rejects anything not in the list.
   */
  region?: RegionKey;
}

/** Metro hubs a node may claim as its region. Coarse on purpose. */
export const REGIONS = {
  'toronto': { name: 'Toronto', lat: 43.7, lon: -79.4 },
  'montreal': { name: 'Montréal', lat: 45.5, lon: -73.6 },
  'vancouver': { name: 'Vancouver', lat: 49.3, lon: -123.1 },
  'new-york': { name: 'New York', lat: 40.7, lon: -74.0 },
  'virginia': { name: 'N. Virginia', lat: 39.0, lon: -77.5 },
  'chicago': { name: 'Chicago', lat: 41.9, lon: -87.6 },
  'dallas': { name: 'Dallas', lat: 32.8, lon: -96.8 },
  'denver': { name: 'Denver', lat: 39.7, lon: -105.0 },
  'los-angeles': { name: 'Los Angeles', lat: 34.1, lon: -118.2 },
  'san-francisco': { name: 'San Francisco', lat: 37.8, lon: -122.4 },
  'seattle': { name: 'Seattle', lat: 47.6, lon: -122.3 },
  'miami': { name: 'Miami', lat: 25.8, lon: -80.2 },
  'mexico-city': { name: 'Mexico City', lat: 19.4, lon: -99.1 },
  'sao-paulo': { name: 'São Paulo', lat: -23.5, lon: -46.6 },
  'buenos-aires': { name: 'Buenos Aires', lat: -34.6, lon: -58.4 },
  'santiago': { name: 'Santiago', lat: -33.4, lon: -70.7 },
  'london': { name: 'London', lat: 51.5, lon: -0.1 },
  'dublin': { name: 'Dublin', lat: 53.3, lon: -6.3 },
  'amsterdam': { name: 'Amsterdam', lat: 52.4, lon: 4.9 },
  'frankfurt': { name: 'Frankfurt', lat: 50.1, lon: 8.7 },
  'paris': { name: 'Paris', lat: 48.9, lon: 2.4 },
  'madrid': { name: 'Madrid', lat: 40.4, lon: -3.7 },
  'milan': { name: 'Milan', lat: 45.5, lon: 9.2 },
  'stockholm': { name: 'Stockholm', lat: 59.3, lon: 18.1 },
  'warsaw': { name: 'Warsaw', lat: 52.2, lon: 21.0 },
  'helsinki': { name: 'Helsinki', lat: 60.2, lon: 24.9 },
  'istanbul': { name: 'Istanbul', lat: 41.0, lon: 29.0 },
  'dubai': { name: 'Dubai', lat: 25.2, lon: 55.3 },
  'tel-aviv': { name: 'Tel Aviv', lat: 32.1, lon: 34.8 },
  'cairo': { name: 'Cairo', lat: 30.0, lon: 31.2 },
  'lagos': { name: 'Lagos', lat: 6.5, lon: 3.4 },
  'nairobi': { name: 'Nairobi', lat: -1.3, lon: 36.8 },
  'johannesburg': { name: 'Johannesburg', lat: -26.2, lon: 28.0 },
  'mumbai': { name: 'Mumbai', lat: 19.1, lon: 72.9 },
  'bangalore': { name: 'Bengaluru', lat: 13.0, lon: 77.6 },
  'singapore': { name: 'Singapore', lat: 1.3, lon: 103.8 },
  'jakarta': { name: 'Jakarta', lat: -6.2, lon: 106.8 },
  'hong-kong': { name: 'Hong Kong', lat: 22.3, lon: 114.2 },
  'taipei': { name: 'Taipei', lat: 25.0, lon: 121.5 },
  'seoul': { name: 'Seoul', lat: 37.6, lon: 127.0 },
  'tokyo': { name: 'Tokyo', lat: 35.7, lon: 139.7 },
  'sydney': { name: 'Sydney', lat: -33.9, lon: 151.2 },
  'melbourne': { name: 'Melbourne', lat: -37.8, lon: 145.0 },
  'auckland': { name: 'Auckland', lat: -36.8, lon: 174.8 },
} as const;
export type RegionKey = keyof typeof REGIONS;
export function isRegion(k: unknown): k is RegionKey {
  return typeof k === 'string' && Object.prototype.hasOwnProperty.call(REGIONS, k);
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

/**
 * Suggested hourly rates by tier, in micro-credits (1,000,000 = $1). These are
 * what the agent advertises unless the operator sets NIGHTSHIFT_HOURLY. The
 * Pricing page's list rates sit above them; the gap funds verification and
 * the router.
 */
export const HOURLY_SUGGESTED: Record<HardwareTier, number> = {
  cpu: 20_000,       // $0.02
  'gpu-8': 90_000,   // $0.09
  'gpu-16': 160_000, // $0.16
  'gpu-24': 260_000, // $0.26
  'gpu-48': 600_000, // $0.60
  'gpu-80': 1_400_000, // $1.40
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

export type Billing = 'tokens' | 'time';

export interface JobInput {
  workload: Workload;
  model: string;
  /** 'tokens' bills output size at the node's per-1k price; 'time' bills seconds of node time at its hourly price. */
  billing?: Billing;
  /** For time billing: the most seconds the requester will pay for. The hold is based on this. */
  maxSeconds?: number;
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
export const PAYOUT_MIN_MICRO = 15 * MICRO;  // minimum SOL or USDC payout
export const LEASE_MS = 90_000;
export const HEARTBEAT_MS = 10_000;
export const OFFLINE_AFTER_MS = 35_000;
export const MAX_ATTEMPTS = 3;
