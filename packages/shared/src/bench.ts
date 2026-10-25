// The registration benchmark.
//
// A node proves it can compute before it is allowed on the map, and the
// router sets its hardware tier from what was measured rather than what was
// claimed. The kernel is integer-only so a GPU, a CPU and the router's own
// check all get the same bits:
//
//   x = seed ^ i
//   repeat K times: x = x * 1664525 + 1013904223;  x ^= x >>> 13
//
// over N elements. The browser runs it as a WebGPU compute shader (or on the
// CPU when WebGPU is missing, which lands it in the cpu tier) in passes until
// about a second and a half has gone by. Throughput is element-iterations per
// second. The router re-computes a handful of elements at indices derived
// from the ticket nonce and refuses the registration if they do not match.
//
// What this does and does not prove: the sampled values show the work was
// really done; the elapsed time is what the client reports, bounded below by
// the router's own clock (you cannot claim a run finished before the ticket
// was issued). A node that lies about speed only changes its suggested price
// and its label; routing is by price, and the router keeps a running measure
// of real job throughput that pulls the tier back down.

import type { HardwareTier } from './index.js';

export const BENCH_N = 1 << 20; // elements per pass
export const BENCH_K = 256; // iterations per element
export const BENCH_TARGET_MS = 1500; // run passes until this much time has gone by
export const BENCH_SAMPLES = 16;
export const BENCH_TICKET_TTL_MS = 10 * 60_000;

export type BenchKind = 'webgpu' | 'cpu' | 'tokens';

export interface BenchTicket {
  id: string;
  nonce: number; // uint32, the kernel seed
  issuedAt: number;
}

export interface BenchResult {
  ticketId: string;
  kind: BenchKind;
  /** Wall time the client measured for all passes. */
  elapsedMs: number;
  /** Passes over the whole buffer (webgpu/cpu). */
  passes: number;
  /** Values at the sampled indices, as uint32. */
  samples: number[];
  /** What the adapter said about itself, if anything. Display only. */
  gpu?: string;
  /** For kind 'tokens' (the native agent): measured output tokens per second. */
  tokensPerSec?: number;
}

/** One element of the kernel on the CPU. Same bits as the shader. */
export function benchElement(seed: number, i: number, k = BENCH_K): number {
  let x = (seed ^ i) >>> 0;
  for (let n = 0; n < k; n++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    x = (x ^ (x >>> 13)) >>> 0;
  }
  return x;
}

/** Which elements the router checks for a given ticket. Spread with a second LCG. */
export function sampleIndices(nonce: number, count = BENCH_SAMPLES, n = BENCH_N): number[] {
  const out: number[] = [];
  let x = (nonce * 2654435761) >>> 0;
  for (let j = 0; j < count; j++) {
    x = (Math.imul(x, 22695477) + 1) >>> 0;
    out.push(x % n);
  }
  return out;
}

/** WGSL for the same kernel. */
export const BENCH_WGSL = `
struct Params { seed: u32, k: u32, n: u32, pad: u32 };
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read_write> out: array<u32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= p.n) { return; }
  var x: u32 = p.seed ^ i;
  for (var n: u32 = 0u; n < p.k; n = n + 1u) {
    x = x * 1664525u + 1013904223u;
    x = x ^ (x >> 13u);
  }
  out[i] = x;
}`;

/** Element-iterations per second → tier. Calibrated roughly; adjust as real runs come in. */
export const BENCH_TIERS: Array<[minScore: number, tier: HardwareTier]> = [
  [0, 'cpu'],
  [2e10, 'gpu-8'],
  [1.2e11, 'gpu-16'],
  [3.5e11, 'gpu-24'],
  [8e11, 'gpu-48'],
  [1.6e12, 'gpu-80'],
];

/** Output tokens per second on a small model → tier, for agents that serve a model. */
export const TOKENS_TIERS: Array<[minTps: number, tier: HardwareTier]> = [
  [0, 'cpu'],
  [12, 'gpu-8'],
  [35, 'gpu-16'],
  [70, 'gpu-24'],
  [120, 'gpu-48'],
  [200, 'gpu-80'],
];

export function tierForScore(score: number, table = BENCH_TIERS): HardwareTier {
  let t: HardwareTier = 'cpu';
  for (const [min, tier] of table) if (score >= min) t = tier;
  return t;
}

export function benchScore(r: { passes: number; elapsedMs: number }): number {
  if (!r.elapsedMs || r.elapsedMs <= 0) return 0;
  return (r.passes * BENCH_N * BENCH_K) / (r.elapsedMs / 1000);
}

/**
 * Verify a result against a ticket. Returns the tier and score or throws
 * with a reason that is safe to show the client.
 */
export function verifyBench(ticket: BenchTicket, r: BenchResult, now: number): { tier: HardwareTier; score: number } {
  if (r.ticketId !== ticket.id) throw new Error('benchmark ticket mismatch');
  if (now - ticket.issuedAt > BENCH_TICKET_TTL_MS) throw new Error('benchmark ticket expired; fetch a new one');
  if (r.kind === 'tokens') {
    const tps = Number(r.tokensPerSec);
    if (!Number.isFinite(tps) || tps <= 0) throw new Error('tokensPerSec required for a tokens benchmark');
    return { tier: tierForScore(tps, TOKENS_TIERS), score: tps };
  }
  const elapsed = Number(r.elapsedMs);
  const passes = Number(r.passes);
  if (!Number.isFinite(elapsed) || elapsed < 200) throw new Error('benchmark ran for too short a time');
  if (!Number.isInteger(passes) || passes < 1 || passes > 100_000) throw new Error('bad pass count');
  // You cannot have finished before you started.
  if (now - ticket.issuedAt < elapsed * 0.9) throw new Error('benchmark timing does not fit the ticket');
  const idx = sampleIndices(ticket.nonce);
  if (!Array.isArray(r.samples) || r.samples.length !== idx.length) throw new Error('benchmark samples missing');
  for (let j = 0; j < idx.length; j++) {
    if ((r.samples[j] >>> 0) !== benchElement(ticket.nonce, idx[j])) throw new Error('benchmark samples do not match; the work was not done');
  }
  const score = r.kind === 'cpu' ? 0 : benchScore({ passes, elapsedMs: elapsed });
  return { tier: r.kind === 'cpu' ? 'cpu' : tierForScore(score), score: benchScore({ passes, elapsedMs: elapsed }) };
}

/**
 * Run the kernel on the CPU. Used by the agent and as the browser fallback.
 * Returns the full buffer so samples can be read out.
 */
export function runBenchCpu(seed: number, n = BENCH_N, k = BENCH_K): Uint32Array {
  const out = new Uint32Array(n);
  for (let i = 0; i < n; i++) out[i] = benchElement(seed, i, k);
  return out;
}
