// Isomorphic node client. The browser worker and the headless worker both
// drive the same loop through this; the only thing they bring is a signer
// and a function that does the work.

import type { JobInput, JobOutput, JobRecord, NodeCapabilities, NodeClass, NodeRecord, Receipt, ReceiptBody } from './index.js';
import type { BenchResult, BenchTicket } from './bench.js';
import { canonical, nodeShareOf } from './index.js';

export interface Signer {
  publicKey: string; // base64url
  sign(message: string): Promise<string> | string; // base64url detached sig
}

export interface NodeClientOptions {
  baseUrl: string;
  signer: Signer;
  class: NodeClass;
  label: string;
  capabilities: NodeCapabilities;
  fetch?: typeof fetch;
  /** Read-only tools pass true so they never overwrite the running worker's settings. */
  lookupOnly?: boolean;
  /** Result of the registration benchmark. Required for a node the router has not seen before. */
  benchmark?: BenchResult;
}

export type WorkFn = (job: JobRecord, signal: AbortSignal) => Promise<JobOutput>;

export interface WorkerEvents {
  status?(s: 'registering' | 'idle' | 'working' | 'offline' | 'error', detail?: string): void;
  job?(j: JobRecord): void;
  done?(j: JobRecord, r: Receipt): void;
  failed?(j: JobRecord, reason: string): void;
}

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

export class NodeClient {
  node: NodeRecord | null = null;
  routerKey = '';
  private f: typeof fetch;

  constructor(private opts: NodeClientOptions) {
    this.f = opts.fetch ?? fetch.bind(globalThis);
  }

  /** Ask the router for a benchmark ticket. The nonce seeds the kernel. */
  async benchTicket(): Promise<BenchTicket> {
    const res = await this.f(`${this.opts.baseUrl}/v1/benchmark/ticket`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message ?? `ticket failed (${res.status})`);
    return data.ticket as BenchTicket;
  }

  setBenchmark(b: BenchResult): void {
    this.opts.benchmark = b;
  }

  async register(): Promise<NodeRecord> {
    const res = await this.f(`${this.opts.baseUrl}/v1/nodes/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        class: this.opts.class,
        label: this.opts.label,
        publicKey: this.opts.signer.publicKey,
        capabilities: this.opts.capabilities,
        lookupOnly: this.opts.lookupOnly,
        benchmark: this.opts.benchmark,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message ?? `register failed (${res.status})`);
    this.node = data.node;
    this.routerKey = data.routerKey;
    return data.node;
  }

  private async signed(method: string, path: string, body?: unknown): Promise<Response> {
    const raw = body === undefined ? '' : JSON.stringify(body);
    const ts = Date.now();
    const msg = `${ts}.${method}.${path}.${await sha256Hex(raw)}`;
    const sig = await this.opts.signer.sign(msg);
    return this.f(`${this.opts.baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-node-auth': `${ts}.${sig}` },
      body: raw || undefined,
    });
  }

  private get id(): string {
    if (!this.node) throw new Error('not registered');
    return this.node.id;
  }

  async heartbeat(busy: boolean): Promise<void> {
    const r = await this.signed('POST', `/v1/nodes/${this.id}/heartbeat`, { busy });
    if (!r.ok) throw new Error(`heartbeat ${r.status}`);
  }

  async claim(): Promise<JobRecord | null> {
    const r = await this.signed('POST', `/v1/nodes/${this.id}/claim`);
    if (r.status === 204) return null;
    const data = await r.json();
    if (!r.ok) throw new Error(data?.error?.message ?? `claim ${r.status}`);
    return data.job;
  }

  async complete(job: JobRecord, output: JobOutput, pricePer1k: number, pricePerHour?: number): Promise<Receipt> {
    const outputHash = await sha256Hex(job.input.workload === 'llm' ? String(output.text ?? '') : String(output.digest ?? ''));
    const finishedAt = Date.now();
    let costMicro: number;
    if (job.input.billing === 'time') {
      // Router time: startedAt came from the router's clock at claim.
      const seconds = Math.max(1, Math.ceil((finishedAt - (job.startedAt ?? finishedAt - output.durationMs)) / 1000));
      costMicro = Math.min(nodeShareOf(job.priceMicro), Math.max(1, Math.ceil((seconds * (pricePerHour ?? 20_000)) / 3600)));
    } else costMicro = Math.min(nodeShareOf(job.priceMicro), Math.max(1, Math.ceil((output.units * pricePer1k) / 1000)));
    const body: ReceiptBody = {
      v: 1,
      jobId: job.id,
      nodeId: this.id,
      nodeClass: this.opts.class,
      workload: job.input.workload,
      model: job.input.model,
      inputHash: job.inputHash,
      outputHash,
      outputTokens: output.outputTokens,
      units: output.units,
      startedAt: job.startedAt ?? finishedAt - output.durationMs,
      finishedAt,
      costMicro,
    };
    const nodeSig = await this.opts.signer.sign(canonical(body));
    const r = await this.signed('POST', `/v1/nodes/${this.id}/jobs/${job.id}/complete`, { output, receipt: body, nodeSig });
    const data = await r.json();
    if (!r.ok) throw new Error(data?.error?.message ?? `complete ${r.status}`);
    return data.receipt;
  }

  async fail(job: JobRecord, reason: string): Promise<void> {
    await this.signed('POST', `/v1/nodes/${this.id}/jobs/${job.id}/fail`, { reason });
  }

  async me(): Promise<unknown> {
    const r = await this.signed('GET', `/v1/nodes/${this.id}/me`);
    return r.json();
  }

  /** Ask for USDC on Solana. Debited now, reviewed by the operator, then sent. */
  async requestPayout(amountMicro: number, address: string): Promise<unknown> {
    const r = await this.signed('POST', `/v1/nodes/${this.id}/payouts`, { amountMicro, address });
    const data = await r.json();
    if (!r.ok) throw new Error(data?.error?.message ?? `payout ${r.status}`);
    return data.payout;
  }
}

/**
 * The worker loop. Register, then alternate between heartbeating and
 * claiming. `shouldWork` lets the browser pause when the tab is hidden or
 * the battery is low without tearing the node down.
 */
export async function runWorker(
  client: NodeClient,
  work: WorkFn,
  ev: WorkerEvents = {},
  opts: { pollMs?: number; shouldWork?: () => boolean; signal?: AbortSignal; sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  const pollMs = opts.pollMs ?? 1500;
  const shouldWork = opts.shouldWork ?? (() => true);
  const signal = opts.signal;
  // Browsers throttle a hidden tab's timers; the page can hand in a sleep
  // backed by a Web Worker, which is not throttled, so a background node
  // keeps its heartbeat.
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  ev.status?.('registering');
  await client.register();
  ev.status?.('idle');

  let lastBeat = 0;
  while (!signal?.aborted) {
    try {
      if (!shouldWork()) {
        // Paused: keep the registration warm but tell the router we're busy
        // so it doesn't route to us.
        if (Date.now() - lastBeat > 8000) {
          await client.heartbeat(true);
          lastBeat = Date.now();
        }
        await sleep(pollMs);
        continue;
      }
      const job = await client.claim();
      lastBeat = Date.now();
      if (!job) {
        await sleep(pollMs);
        continue;
      }
      ev.status?.('working', job.id);
      ev.job?.(job);
      let working = true;
      const beat = (async () => {
        while (working) {
          await sleep(8000);
          if (working) await client.heartbeat(true).catch(() => {});
        }
      })();
      try {
        const ctrl = new AbortController();
        const output = await work(job, ctrl.signal);
        const receipt = await client.complete(job, output, client.node!.capabilities.pricePer1k, client.node!.capabilities.pricePerHour);
        ev.done?.(job, receipt);
      } catch (err) {
        const reason = (err as Error).message ?? String(err);
        await client.fail(job, reason).catch(() => {});
        ev.failed?.(job, reason);
      } finally {
        working = false;
        void beat;
      }
      ev.status?.('idle');
    } catch (err) {
      ev.status?.('error', (err as Error).message);
      await sleep(Math.max(pollMs, 3000));
      // If the router restarted and forgot us, re-register on the next loop.
      try {
        await client.heartbeat(false);
      } catch {
        try {
          await client.register();
          ev.status?.('idle');
        } catch {
          /* keep looping */
        }
      }
    }
  }
  ev.status?.('offline');
}

export type { JobInput };
