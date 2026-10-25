// Preview-only backend. Reimplements the router inside the page so the site
// can be shown somewhere the real API can't run. Same rules: cheapest capable
// node wins, holds and refunds, real ed25519 signatures on receipts, compute
// jobs actually run. The llm replies are canned and the page says so.
//
// Installed by preview.ts; never bundled into the real app.

import nacl from 'tweetnacl';
import type { JobInput, JobOutput, JobRecord, LiveEvent, NetworkStats, NodeCapabilities, NodeClass, PublicNode, Receipt, ReceiptBody } from '@nightshift/shared';
import { canonical, computeTask, COMPUTE_ROUNDS_PER_UNIT, FREE_GRANT_MICRO, PAYOUT_MIN_MICRO, PRICE_FLOOR_PER_1K, HOURLY_SUGGESTED, tierForVram, type HardwareTier } from '@nightshift/shared';

const enc = new TextEncoder();
function b64u(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64u(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad), (c) => c.charCodeAt(0));
}
async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}
function sign(msg: string, sk: Uint8Array): string {
  return b64u(nacl.sign.detached(enc.encode(msg), sk));
}
function verify(msg: string, sig: string, pk: string): boolean {
  try {
    return nacl.sign.detached.verify(enc.encode(msg), fromB64u(sig), fromB64u(pk));
  } catch {
    return false;
  }
}
let counter = 0;
function id(p: string): string {
  return `${p}_${(Date.now() % 100000).toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

interface MNode {
  id: string;
  cls: NodeClass;
  label: string;
  pk: string;
  sk?: Uint8Array; // only for simulated nodes
  caps: NodeCapabilities;
  status: 'online' | 'busy' | 'offline';
  jobsDone: number;
  jobsFailed: number;
  units: number;
  earned: number;
  balance: number;
  simulated: boolean;
  lastSeen: number;
  uptime: number;
  payouts: { id: string; status: string; rail: string; amountMicro: number; createdAt: number }[];
}

const REPLIES = [
  'A receipt lets you check who did the work and what it cost without taking anyone’s word for it. In this preview the reply is canned; on the real network a node runs a small model and signs what it produced.',
  'Short version: the router picks the cheapest machine that can run your request, that machine signs the result, the router countersigns, and you keep the receipt. This preview fakes the model but not the signatures.',
  'The honest answer is that this text was written ahead of time. Everything around it is real: the job was queued, routed, held, settled and signed by a key living in this page.',
  'Routing is just a sort: every idle node that serves the model and fits the limits is a candidate, lowest price wins. Try the simulator on the home page to watch it happen.',
];

export class MockRouter {
  private rk = nacl.sign.keyPair();
  routerKey = b64u(this.rk.publicKey);
  private nodes = new Map<string, MNode>();
  private jobs = new Map<string, JobRecord>();
  private receipts = new Map<string, Receipt>();
  private balance = FREE_GRANT_MICRO;
  private ledger: { id: string; deltaMicro: number; kind: string; ref?: string; createdAt: number }[] = [];
  private sockets = new Set<MockSocket>();
  private lat: number[] = [];

  constructor() {
    this.ledger.push({ id: id('lg'), deltaMicro: FREE_GRANT_MICRO, kind: 'grant', ref: 'welcome', createdAt: Date.now() });
    // A varied simulated fleet so the preview map shows what a real network of
    // consumer cards looks like. All simulated; the banner says so.
    const GPUS: [string, number][] = [
      ['NVIDIA GeForce RTX 4090', 24], ['NVIDIA GeForce RTX 4080', 16], ['NVIDIA GeForce RTX 4070 Ti', 12], ['NVIDIA GeForce RTX 4060', 8],
      ['NVIDIA GeForce RTX 3090', 24], ['NVIDIA GeForce RTX 3080', 10], ['NVIDIA GeForce RTX 3070', 8], ['NVIDIA GeForce RTX 3060', 12],
      ['AMD Radeon RX 7900 XTX', 24], ['AMD Radeon RX 7800 XT', 16], ['AMD Radeon RX 6700 XT', 12],
      ['Apple M2 Max', 32], ['Apple M3 Pro', 18], ['Apple M1', 8],
      ['NVIDIA RTX A6000', 48], ['NVIDIA A100 80GB', 80], ['NVIDIA L4', 24], ['NVIDIA Tesla T4', 16],
    ];
    const NAMES = ['quiet-lamp', 'brisk-kettle', 'plain-harbour', 'early-ledger', 'spare-pebble', 'steady-maple', 'small-anvil', 'blue-cedar', 'grey-copper', 'calm-quill', 'late-birch', 'dry-slate', 'warm-ferry', 'low-orchard', 'still-gravel', 'far-lantern', 'soft-granite', 'pale-rudder', 'thin-walnut', 'old-pier', 'high-thistle', 'near-cobble', 'mild-saddle', 'clear-fathom', 'deep-marrow', 'odd-shingle', 'keen-tallow', 'fine-barrow'];
    for (let i = 0; i < 28; i++) {
      const [gpu, vram] = GPUS[(i * 7) % GPUS.length];
      const tier = tierForVram(vram);
      const native = i % 3 !== 0;
      const price = { cpu: 250, 'gpu-8': 300, 'gpu-16': 420, 'gpu-24': 620, 'gpu-48': 1100, 'gpu-80': 1900 }[tier] + ((i * 37) % 90);
      this.simNode(native ? 'native' : 'browser', `${NAMES[i % NAMES.length]}-${100 + ((i * 53) % 900)}`, {
        workloads: native ? ['llm', 'compute'] : ['compute'],
        models: native ? (vram >= 16 ? ['qwen2.5-0.5b-instruct', 'qwen2.5-7b-instruct'] : ['qwen2.5-0.5b-instruct']) : [],
        maxPromptChars: native ? 16000 : 6000,
        maxOutputTokens: native ? 1024 : 128,
        pricePer1k: price,
        pricePerHour: HOURLY_SUGGESTED[tier] + ((i * 13) % 20) * 1000,
        tokensPerSec: native ? 20 + vram : 6,
        hardware: { gpu: native ? gpu : undefined, vramGb: native ? vram : undefined, tier: native ? tier : 'cpu' },
      });
    }
    // Two tabs with no model so compute test jobs have cheap takers.
    this.simNode('browser', 'chrome on windows', { workloads: ['compute'], models: [], maxPromptChars: 6000, maxOutputTokens: 128, pricePer1k: 210, pricePerHour: 20_000, tokensPerSec: 9, hardware: { tier: 'cpu' } });
    this.simNode('browser', 'firefox on mac', { workloads: ['llm', 'compute'], models: ['qwen2.5-0.5b-instruct'], maxPromptChars: 6000, maxOutputTokens: 192, pricePer1k: 230, pricePerHour: 90_000, tokensPerSec: 18, hardware: { gpu: 'Apple M1', tier: 'gpu-8' } });
    setInterval(() => this.emit({ t: 'stats', stats: this.stats() }), 4000);
    // Simulated customer traffic: a job every couple of seconds, billed to a
    // demo account rather than the viewer. Keeps the map moving.
    const tick = () => {
      const llm = Math.random() < 0.55;
      const timeBilled = Math.random() < 0.4; // routes by hourly price, so a different node wins
      void this.enqueue(
        llm
          ? { workload: 'llm', model: Math.random() < 0.35 ? 'qwen2.5-7b-instruct' : 'qwen2.5-0.5b-instruct', messages: [{ role: 'user', content: 'demo' }], maxOutputTokens: 64 + Math.floor(Math.random() * 160), billing: timeBilled ? 'time' : 'tokens', maxSeconds: 30 }
          : { workload: 'compute', rounds: 20_000 + Math.floor(Math.random() * 120_000), billing: timeBilled ? 'time' : 'tokens', maxSeconds: 30 },
        true,
      ).catch(() => {});
      setTimeout(tick, 350 + Math.random() * 900);
    };
    setTimeout(tick, 1500);
    // Occasionally a simulated node comes and goes so the map has some life.
    setInterval(() => {
      if (Math.random() < 0.4) {
        const n = this.simNode('browser', ['safari on mac', 'edge on linux', 'brave on windows'][Math.floor(Math.random() * 3)] + '-' + Math.floor(100 + Math.random() * 900), { workloads: ['compute'], models: [], maxPromptChars: 4000, maxOutputTokens: 128, pricePer1k: 200 + Math.floor(Math.random() * 90), pricePerHour: 20_000, hardware: { tier: 'cpu' } });
        setTimeout(() => {
          if (n.status !== 'busy') {
            n.status = 'offline';
            this.nodes.delete(n.id);
            this.emit({ t: 'node.down', nodeId: n.id });
          }
        }, 20_000 + Math.random() * 40_000);
      }
    }, 25_000);
  }

  private simNode(cls: NodeClass, label: string, caps: NodeCapabilities & { hardware?: { gpu?: string; vramGb?: number; tier?: HardwareTier } }): MNode {
    const kp = nacl.sign.keyPair();
    const n: MNode = { id: id('nd'), cls, label, pk: b64u(kp.publicKey), sk: kp.secretKey, caps, status: 'online', jobsDone: Math.floor(Math.random() * 30), jobsFailed: 0, units: 0, earned: 0, balance: 0, simulated: true, lastSeen: Date.now(), uptime: 0, payouts: [] };
    this.nodes.set(n.id, n);
    this.emit({ t: 'node.up', node: this.pub(n) });
    return n;
  }

  private pub(n: MNode): PublicNode {
    return { id: n.id, class: n.cls, label: n.label, status: n.status, capabilities: n.caps, jobsDone: n.jobsDone };
  }

  attach(s: MockSocket): void {
    this.sockets.add(s);
    s.deliver({ t: 'hello', stats: this.stats(), nodes: this.online().map((n) => this.pub(n)) });
  }
  detach(s: MockSocket): void {
    this.sockets.delete(s);
  }
  private emit(ev: LiveEvent): void {
    for (const s of this.sockets) s.deliver(ev);
  }

  private online(): MNode[] {
    return Array.from(this.nodes.values()).filter((n) => n.status !== 'offline');
  }

  stats(): NetworkStats {
    const byClass: Record<NodeClass, number> = { browser: 0, native: 0, cloud: 0, external: 0 };
    for (const n of this.online()) byClass[n.cls]++;
    const all = Array.from(this.jobs.values());
    const done = all.filter((j) => j.status === 'done').length;
    const failed = all.filter((j) => j.status === 'failed').length;
    const sorted = [...this.lat].sort((a, b) => a - b);
    const pct = (p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0);
    const llm = this.online().filter((n) => n.caps.workloads.includes('llm') && n.status !== 'offline');
    return {
      nodesOnline: this.online().length,
      nodesRegistered: this.nodes.size,
      nodesByClass: byClass,
      jobsQueued: all.filter((j) => j.status === 'queued').length,
      jobsRunning: all.filter((j) => j.status === 'assigned' || j.status === 'running').length,
      jobsDone: done,
      jobsFailed: failed,
      unitsVerified: Array.from(this.nodes.values()).reduce((a, n) => a + n.units, 0),
      successRate: done + failed ? done / (done + failed) : 1,
      p50Ms: pct(0.5),
      p95Ms: pct(0.95),
      floorPricePer1k: llm.length ? Math.min(...llm.map((n) => n.caps.pricePer1k)) : null,
    };
  }

  // --- jobs -----------------------------------------------------------------

  private candidates(input: JobInput): MNode[] {
    const chars = (input.messages ?? []).reduce((n, m) => n + m.content.length, 0);
    return this.online().filter((n) => n.status === 'online' && n.caps.workloads.includes(input.workload) && (input.workload !== 'llm' || n.caps.models.includes(input.model)) && chars <= n.caps.maxPromptChars && (input.maxOutputTokens ?? 0) <= n.caps.maxOutputTokens);
  }

  async enqueue(raw: Partial<JobInput>, demo = false): Promise<JobRecord> {
    let input: JobInput;
    const billing = raw.billing === 'time' ? 'time' : 'tokens';
    const maxSeconds = billing === 'time' ? Math.min(3600, Math.max(5, Number(raw.maxSeconds ?? 60))) : undefined;
    if (raw.workload === 'compute') input = { workload: 'compute', billing, maxSeconds, model: 'hashchain-v1', seed: Math.floor(Number(raw.seed ?? Math.random() * 2 ** 31)), rounds: Math.min(2_000_000, Math.max(1000, Number(raw.rounds ?? 100_000))) };
    else {
      if (!raw.messages?.length) throw new HttpError(400, 'messages required');
      input = { workload: 'llm', billing, maxSeconds, model: String(raw.model ?? 'qwen2.5-0.5b-instruct'), messages: raw.messages, maxOutputTokens: Math.min(2048, Math.max(1, Number(raw.maxOutputTokens ?? 128))), temperature: Number(raw.temperature ?? 0.7) };
    }
    const units = input.workload === 'llm' ? input.maxOutputTokens! : Math.ceil(input.rounds! / COMPUTE_ROUNDS_PER_UNIT);
    const cands = this.candidates(input);
    let price: number;
    if (billing === 'time') {
      const perHour = cands.length ? Math.min(...cands.map((n) => n.caps.pricePerHour ?? 20_000)) : 20_000;
      price = Math.max(1, Math.ceil(((maxSeconds ?? 60) * perHour) / 3600));
    } else {
      const per1k = cands.length ? Math.min(...cands.map((n) => n.caps.pricePer1k)) : PRICE_FLOOR_PER_1K;
      price = Math.max(1, Math.ceil((units * per1k) / 1000));
    }
    if (!demo) {
      if (this.balance < price) throw new HttpError(402, `not enough credits: need ${price}, have ${this.balance}`);
      this.balance -= price;
      this.ledger.unshift({ id: id('lg'), deltaMicro: -price, kind: 'charge', createdAt: Date.now() });
    }
    const job: JobRecord = { id: id('job'), status: 'queued', requesterId: demo ? 'demo' : 'session', input, inputHash: await sha256(canonical(input)), attempts: 0, priceMicro: price, createdAt: Date.now() };
    if (!demo) this.ledger[0].ref = job.id;
    this.jobs.set(job.id, job);
    this.emit({ t: 'job.queued', jobId: job.id, workload: input.workload, model: input.model });
    setTimeout(() => this.dispatch(), 350);
    return job;
  }

  dispatch(): void {
    for (const job of Array.from(this.jobs.values()).filter((j) => j.status === 'queued').sort((a, b) => a.createdAt - b.createdAt)) {
      const byTime = job.input.billing === 'time';
      const pr = (n: MNode) => (byTime ? n.caps.pricePerHour ?? 20_000 : n.caps.pricePer1k);
      const cands = this.candidates(job.input).sort((a, b) => pr(a) - pr(b) || (b.caps.tokensPerSec ?? 0) - (a.caps.tokensPerSec ?? 0));
      const node = cands[0];
      if (!node) continue;
      job.status = 'assigned';
      job.nodeId = node.id;
      job.assignedAt = Date.now();
      job.attempts++;
      node.status = 'busy';
      this.emit({ t: 'job.assigned', jobId: job.id, nodeId: node.id });
      this.emit({ t: 'node.busy', nodeId: node.id, busy: true });
      if (node.simulated) void this.runSimulated(job, node);
    }
  }

  private async runSimulated(job: JobRecord, node: MNode): Promise<void> {
    await new Promise((r) => setTimeout(r, 400));
    job.status = 'running';
    job.startedAt = Date.now();
    let output: JobOutput;
    if (job.input.workload === 'compute') {
      const t0 = performance.now();
      const digest = await computeTask(job.input.seed!, job.input.rounds!);
      const pad = job.requesterId === 'demo' ? 1200 + Math.random() * 2800 : 300;
      output = { digest, outputTokens: 0, units: Math.ceil(job.input.rounds! / COMPUTE_ROUNDS_PER_UNIT), durationMs: performance.now() - t0 + pad };
      await new Promise((r) => setTimeout(r, pad));
    } else {
      const text = REPLIES[Math.floor(Math.random() * REPLIES.length)];
      const toks = Math.min(job.input.maxOutputTokens ?? 128, Math.ceil(text.length / 4));
      const ms = (job.requesterId === 'demo' ? 900 + Math.random() * 2500 : 600) + toks * 12;
      await new Promise((r) => setTimeout(r, ms));
      output = { text, outputTokens: toks, units: toks, durationMs: ms };
    }
    const outputHash = await sha256(job.input.workload === 'llm' ? output.text! : output.digest!);
    const cost = this.costFor(job, node, output.units);
    const body: ReceiptBody = { v: 1, jobId: job.id, nodeId: node.id, nodeClass: node.cls, workload: job.input.workload, model: job.input.model, inputHash: job.inputHash, outputHash, outputTokens: output.outputTokens, units: output.units, startedAt: job.startedAt, finishedAt: Date.now(), costMicro: cost };
    await this.complete(node.id, job.id, output, body, sign(canonical(body), node.sk!));
  }

  private costFor(job: JobRecord, node: MNode, units: number): number {
    if (job.input.billing === 'time') {
      const seconds = Math.max(1, Math.ceil((Date.now() - (job.startedAt ?? job.createdAt)) / 1000));
      return Math.min(job.priceMicro, Math.max(1, Math.ceil((seconds * (node.caps.pricePerHour ?? 20_000)) / 3600)));
    }
    return Math.min(job.priceMicro, Math.max(1, Math.ceil((units * node.caps.pricePer1k) / 1000)));
  }

  async complete(nodeId: string, jobId: string, output: JobOutput, body: ReceiptBody, nodeSig: string): Promise<Receipt> {
    const job = this.jobs.get(jobId);
    const node = this.nodes.get(nodeId);
    if (!job || !node || job.nodeId !== nodeId || !['assigned', 'running'].includes(job.status)) throw new HttpError(409, 'job is not yours or not running');
    const outputHash = await sha256(job.input.workload === 'llm' ? String(output.text ?? '') : String(output.digest ?? ''));
    for (const [k, v] of Object.entries({ v: 1, jobId: job.id, nodeId, nodeClass: node.cls, workload: job.input.workload, model: job.input.model, inputHash: job.inputHash, outputHash })) {
      if ((body as unknown as Record<string, unknown>)[k] !== v) throw new HttpError(400, `receipt field mismatch: ${k}`);
    }
    const canon = canonical(body);
    if (!verify(canon, nodeSig, node.pk)) throw new HttpError(400, 'bad node signature');
    if (job.input.workload === 'compute' && (await computeTask(job.input.seed!, job.input.rounds!)) !== output.digest) {
      node.jobsFailed++;
      node.status = 'online';
      job.status = 'failed';
      job.error = 'spot check failed';
      if (job.requesterId !== 'demo') this.balance += job.priceMicro;
      this.emit({ t: 'job.failed', jobId: job.id, nodeId, reason: 'spot check failed: output digest did not match' });
      throw new HttpError(422, 'spot check failed');
    }
    const units = output.units;
    const cost = this.costFor(job, node, units);
    if (body.costMicro !== cost) {
      const slack = Math.ceil((2 * (node.caps.pricePerHour ?? 20_000)) / 3600) + 1;
      if (!(job.input.billing === 'time' && body.costMicro <= job.priceMicro && Math.abs(body.costMicro - cost) <= slack)) throw new HttpError(400, `receipt cost mismatch (expected ${cost})`);
    }
    const receipt: Receipt = { id: id('rcpt'), body, nodeSig, routerSig: sign(canon + '.' + nodeSig, this.rk.secretKey), routerKey: this.routerKey, nodeKey: node.pk };
    job.status = 'done';
    job.output = output;
    job.costMicro = body.costMicro;
    job.finishedAt = Date.now();
    const refund = job.priceMicro - body.costMicro;
    if (job.requesterId !== 'demo') {
      this.balance += refund;
      if (refund) this.ledger.unshift({ id: id('lg'), deltaMicro: refund, kind: 'refund', ref: job.id, createdAt: Date.now() });
    }
    node.jobsDone++;
    node.units += units;
    node.earned += body.costMicro;
    node.balance += body.costMicro;
    node.status = 'online';
    this.receipts.set(receipt.id, receipt);
    this.lat.push(job.finishedAt - job.createdAt);
    if (this.lat.length > 100) this.lat.shift();
    if (this.jobs.size > 400) for (const k of Array.from(this.jobs.keys()).slice(0, 100)) this.jobs.delete(k);
    if (this.receipts.size > 200) for (const k of Array.from(this.receipts.keys()).slice(0, 50)) this.receipts.delete(k);
    this.emit({ t: 'job.done', jobId: job.id, nodeId, units, durationMs: job.finishedAt - (job.startedAt ?? job.createdAt), costMicro: body.costMicro });
    this.emit({ t: 'node.busy', nodeId, busy: false });
    setTimeout(() => this.dispatch(), 100);
    return receipt;
  }

  fail(nodeId: string, jobId: string, reason: string): void {
    const job = this.jobs.get(jobId);
    const node = this.nodes.get(nodeId);
    if (!job || !node) throw new HttpError(409, 'no such job');
    node.jobsFailed++;
    node.status = 'online';
    if (job.attempts >= 3) {
      job.status = 'failed';
      job.error = reason;
      if (job.requesterId !== 'demo') this.balance += job.priceMicro;
      this.emit({ t: 'job.failed', jobId, nodeId, reason });
    } else {
      job.status = 'queued';
      job.nodeId = undefined;
      this.emit({ t: 'job.failed', jobId, nodeId, reason: `${reason}, requeued` });
      setTimeout(() => this.dispatch(), 300);
    }
  }

  async waitFor(jobId: string, ms: number): Promise<JobRecord | undefined> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const j = this.jobs.get(jobId);
      if (!j || ['done', 'failed'].includes(j.status)) return j;
      await new Promise((r) => setTimeout(r, 150));
    }
    return this.jobs.get(jobId);
  }

  receiptFor(idOrJob: string): Receipt | undefined {
    return this.receipts.get(idOrJob) ?? Array.from(this.receipts.values()).find((r) => r.body.jobId === idOrJob);
  }

  checkReceipt(r: Receipt) {
    const canon = canonical(r.body);
    const nodeOk = verify(canon, r.nodeSig, r.nodeKey);
    const routerOk = verify(canon + '.' + r.nodeSig, r.routerSig, r.routerKey);
    return { valid: nodeOk && routerOk, nodeSignature: nodeOk, routerSignature: routerOk, routerIsThisRouter: r.routerKey === this.routerKey, canonical: canon };
  }

  // --- HTTP surface -----------------------------------------------------------

  async handle(method: string, path: string, body: unknown, headers: Record<string, string>): Promise<{ status: number; body?: unknown }> {
    const b = (body ?? {}) as Record<string, any>;
    const m = (re: RegExp) => path.match(re);
    let x: RegExpMatchArray | null;

    if (path === '/health') return { status: 200, body: { ok: true, routerKey: this.routerKey } };
    if (path === '/v1/network') return { status: 200, body: { stats: this.stats(), routerKey: this.routerKey } };
    if (path === '/v1/router-key') return { status: 200, body: { publicKey: this.routerKey, alg: 'ed25519' } };
    if (path === '/v1/nodes' && method === 'GET') return { status: 200, body: { nodes: this.online().map((n) => this.pub(n)) } };
    if (path === '/v1/me') return { status: 200, body: { accountId: 'sess_preview', balanceMicro: this.balance, ledger: this.ledger.slice(0, 30) } };
    if (path === '/v1/quotes') return { status: 200, body: { ok: true } };
    if (path === '/v1/keys') return { status: 200, body: { accountId: id('acct'), apiKey: 'ns_preview_' + id('k'), note: 'preview key; the real router stores a hash' } };
    if (path === '/v1/receipts' && method === 'GET') return { status: 200, body: { receipts: Array.from(this.receipts.values()).reverse().slice(0, 10) } };
    if (path === '/v1/receipts/verify') return b.receipt?.body ? { status: 200, body: this.checkReceipt(b.receipt) } : { status: 400, body: err('receipt required') };
    if ((x = m(/^\/v1\/receipts\/([^/]+)$/))) {
      const r = this.receiptFor(x[1]);
      return r ? { status: 200, body: { receipt: r, valid: this.checkReceipt(r) } } : { status: 404, body: err('receipt not found') };
    }
    if (path === '/v1/jobs' && method === 'POST') return { status: 202, body: await this.enqueue(b) };
    if (path === '/v1/jobs' && method === 'GET') return { status: 200, body: { jobs: Array.from(this.jobs.values()).filter((j) => j.requesterId === 'session').reverse().slice(0, 20) } };
    if ((x = m(/^\/v1\/jobs\/([^/]+)$/))) {
      const j = this.jobs.get(x[1]);
      return j ? { status: 200, body: { ...j, receipt: j.status === 'done' ? this.receiptFor(j.id) : undefined } } : { status: 404, body: err('job not found') };
    }
    if (path === '/v1/chat/completions') {
      const job = await this.enqueue({ workload: 'llm', model: b.model, messages: b.messages, maxOutputTokens: b.max_tokens, temperature: b.temperature });
      const done = await this.waitFor(job.id, 60_000);
      if (!done || done.status !== 'done') return { status: done?.status === 'failed' ? 502 : 504, body: { error: { message: done?.error ?? 'no node picked the job up in time; it is still queued', type: 'routing_error', job_id: job.id } } };
      const r = this.receiptFor(done.id);
      return { status: 200, body: { id: 'chatcmpl-' + done.id, object: 'chat.completion', created: Math.floor(done.createdAt / 1000), model: done.input.model, choices: [{ index: 0, message: { role: 'assistant', content: done.output?.text ?? '' }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: done.output?.outputTokens ?? 0, total_tokens: 12 + (done.output?.outputTokens ?? 0) }, nightshift: { job_id: done.id, node_id: done.nodeId, receipt_id: r?.id, cost_micro: done.costMicro, duration_ms: (done.finishedAt ?? 0) - (done.startedAt ?? done.createdAt) } } };
    }

    // nodes (the Earn page's own node talks to these)
    if (path === '/v1/nodes/register') {
      if (b.class === 'cloud' || b.class === 'external') return { status: 403, body: err('cloud and external node classes are disabled on this router') };
      let n = Array.from(this.nodes.values()).find((q) => q.pk === b.publicKey);
      if (b.lookupOnly) return n ? { status: 200, body: { node: this.rec(n), routerKey: this.routerKey } } : { status: 400, body: err('no node registered with this key; run the worker first') };
      if (!n) {
        n = { id: id('nd'), cls: b.class ?? 'browser', label: String(b.label ?? 'unnamed').slice(0, 48), pk: b.publicKey, caps: { ...b.capabilities, pricePer1k: Math.max(PRICE_FLOOR_PER_1K, Number(b.capabilities?.pricePer1k ?? PRICE_FLOOR_PER_1K)) }, status: 'online', jobsDone: 0, jobsFailed: 0, units: 0, earned: 0, balance: 0, simulated: false, lastSeen: Date.now(), uptime: 0, payouts: [] };
        this.nodes.set(n.id, n);
      } else {
        n.status = 'online';
        n.label = b.label;
        n.caps = b.capabilities;
      }
      this.emit({ t: 'node.up', node: this.pub(n) });
      setTimeout(() => this.dispatch(), 200);
      return { status: 200, body: { node: this.rec(n), routerKey: this.routerKey } };
    }
    if ((x = m(/^\/v1\/nodes\/([^/]+)\/(heartbeat|claim|me|payouts|jobs\/([^/]+)\/(complete|fail))$/))) {
      const n = this.nodes.get(x[1]);
      if (!n) return { status: 404, body: err('unknown node') };
      if (!(await this.nodeAuth(n, method, path, headers, body))) return { status: 401, body: err('bad node signature') };
      const action = x[2].startsWith('jobs/') ? x[4] : x[2];
      if (action === 'heartbeat') {
        n.uptime += Math.min(35_000, Date.now() - n.lastSeen);
        n.lastSeen = Date.now();
        if (n.status !== 'busy' || !b.busy) n.status = b.busy ? 'busy' : 'online';
        if (!b.busy) this.dispatch();
        return { status: 200, body: { ok: true, serverTime: Date.now() } };
      }
      if (action === 'claim') {
        n.uptime += Math.min(35_000, Date.now() - n.lastSeen);
        n.lastSeen = Date.now();
        if (n.status === 'offline') n.status = 'online';
        this.dispatch();
        const j = Array.from(this.jobs.values()).find((q) => q.nodeId === n.id && q.status === 'assigned');
        if (!j) return { status: 204 };
        j.status = 'running';
        j.startedAt = Date.now();
        return { status: 200, body: { job: { ...j, requesterId: 'hidden' } } };
      }
      if (action === 'complete') return { status: 200, body: { receipt: await this.complete(n.id, x[3], b.output, b.receipt, b.nodeSig) } };
      if (action === 'fail') {
        this.fail(n.id, x[3], String(b.reason ?? 'failed'));
        return { status: 200, body: { ok: true } };
      }
      if (action === 'me') return { status: 200, body: { node: this.rec(n), uptimeMs24h: n.uptime, payoutMinMicro: PAYOUT_MIN_MICRO, balanceMicro: n.balance, ledger: [], jobs: Array.from(this.jobs.values()).filter((q) => q.nodeId === n.id).reverse().slice(0, 20).map((j) => ({ ...j, requesterId: 'hidden', input: { ...j.input, messages: undefined }, output: j.output ? { ...j.output, text: j.output.text === undefined ? undefined : '[hidden]' } : undefined })), payouts: n.payouts } };
      if (action === 'payouts') {
        const amt = Number(b.amountMicro);
        if (!amt || amt > n.balance) return { status: 400, body: err('amount exceeds balance') };
        if (b.rail === 'credits') return { status: 200, body: { payout: { id: id('po'), status: 'sent', rail: 'credits', amountMicro: amt } } };
        if (amt < PAYOUT_MIN_MICRO) return { status: 400, body: err(`minimum payout for ${b.rail} is $${PAYOUT_MIN_MICRO / 1e6}`) };
        n.balance -= amt;
        const p = { id: id('po'), status: 'pending', rail: b.rail, amountMicro: amt, createdAt: Date.now() };
        n.payouts.unshift(p);
        return { status: 200, body: { payout: p } };
      }
    }
    return { status: 404, body: err('not found') };
  }

  private async nodeAuth(n: MNode, method: string, path: string, headers: Record<string, string>, body: unknown): Promise<boolean> {
    const hdr = headers['x-node-auth'];
    if (!hdr) return false;
    const [ts, sig] = hdr.split('.');
    if (Math.abs(Date.now() - Number(ts)) > 60_000) return false;
    const raw = body === undefined ? '' : ((body as { __raw?: string }).__raw ?? (typeof body === 'string' ? body : JSON.stringify(body)));
    return verify(`${ts}.${method}.${path}.${await sha256(raw)}`, sig, n.pk);
  }

  private rec(n: MNode) {
    return { id: n.id, class: n.cls, label: n.label, publicKey: n.pk, capabilities: n.caps, status: n.status, lastSeen: n.lastSeen, createdAt: n.lastSeen, jobsDone: n.jobsDone, jobsFailed: n.jobsFailed, unitsVerified: n.units, earnedMicro: n.earned };
  }
}

function err(message: string) {
  return { error: { message, type: 'invalid_request' } };
}
class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Stand-in for the live WebSocket. */
export class MockSocket {
  static router: MockRouter;
  readyState = 0;
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  constructor(_url: string) {
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.({});
      MockSocket.router.attach(this);
    }, 60);
  }
  deliver(ev: LiveEvent): void {
    if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify(ev) });
  }
  send(): void {}
  close(): void {
    this.readyState = 3;
    MockSocket.router.detach(this);
    this.onclose?.({});
  }
}

/** Route fetch() calls for /v1 and /health into the mock. Everything else passes through. */
export function installMock(): MockRouter {
  const router = new MockRouter();
  MockSocket.router = router;
  const realFetch = window.fetch.bind(window);
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const u = new URL(url, location.href);
    if (!u.pathname.startsWith('/v1') && u.pathname !== '/health') return realFetch(input, init);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? {}).forEach((v, k) => (headers[k] = v));
    let body: unknown = undefined;
    if (init?.body) {
      const raw = String(init.body);
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
      // signatures are over the raw bytes, so hand those through too
      (body as Record<string, unknown>) && Object.defineProperty(body as object, '__raw', { value: raw, enumerable: false });
    }
    try {
      const res = await router.handle(method, u.pathname, body, headers);
      return new Response(res.status === 204 ? null : JSON.stringify(res.body), { status: res.status, headers: { 'content-type': 'application/json' } });
    } catch (e) {
      const he = e as HttpError;
      return new Response(JSON.stringify(err(he.message)), { status: he.status ?? 500, headers: { 'content-type': 'application/json' } });
    }
  }) as typeof fetch;
  (window as unknown as { WebSocket: unknown }).WebSocket = MockSocket;
  return router;
}
