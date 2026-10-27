// Job lifecycle: enqueue -> assign (cheapest capable idle node) -> node runs
// it -> node returns output + signature -> we verify, countersign, settle.
//
// Nodes pull. The router decides who gets what; a node's /claim call only
// returns work already assigned to it. That keeps "cheapest machine wins"
// a router decision rather than a race between nodes.

import type { Db } from '../db/index.js';
import { id, nowMs } from '../db/index.js';
import type {
  JobInput,
  JobOutput,
  JobRecord,
  JobStatus,
  NodeRecord,
  Receipt,
  ReceiptBody,
} from '@nightshift/shared';
import {
  canonical,
  computeTask,
  COMPUTE_MAX_ROUNDS,
  COMPUTE_MIN_ROUNDS,
  COMPUTE_ROUNDS_PER_UNIT,
  LEASE_MS,
  MAX_ATTEMPTS,
  PRICE_FLOOR_PER_1K,
  HOURLY_FLOOR,
  withFee,
  nodeShareOf,
} from '@nightshift/shared';
import { sha256Hex, sign, verify, type KeyPair } from './crypto.js';
import type { Ledger } from './ledger.js';
import type { Live } from './live.js';
import type { Nodes } from './nodes.js';

export class JobError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export class Router {
  constructor(
    private db: Db,
    private nodes: Nodes,
    private ledger: Ledger,
    private live: Live,
    private routerKey: KeyPair,
  ) {}

  // --- enqueue ------------------------------------------------------------

  enqueue(requesterId: string, raw: Partial<JobInput>, batchId?: string): JobRecord {
    const input = this.validate(raw);
    const inputHash = sha256Hex(canonical(input));
    const units = estimateUnits(input);

    // Quote against the cheapest node that could take it right now. If none
    // is online we still accept the job at the floor and let it wait.
    const cands = this.nodes.candidates(input.workload, input.model, promptChars(input), input.maxOutputTokens ?? 0);
    // The hold is the node's price plus the platform fee: what the business pays.
    let priceMicro: number;
    if (input.billing === 'time') {
      const perHour = cands.length ? Math.min(...cands.map((n) => n.capabilities.pricePerHour ?? Infinity)) : HOURLY_FLOOR.cpu;
      priceMicro = withFee(Math.max(1, Math.ceil(((input.maxSeconds ?? 60) * perHour) / 3600)));
    } else {
      const per1k = cands.length ? Math.min(...cands.map((n) => n.capabilities.pricePer1k)) : PRICE_FLOOR_PER_1K;
      priceMicro = withFee(Math.max(1, Math.ceil((units * per1k) / 1000)));
    }

    const job: JobRecord = {
      id: id('job'),
      status: 'queued',
      requesterId,
      input,
      inputHash,
      attempts: 0,
      priceMicro,
      createdAt: nowMs(),
    };

    const tx = this.db.transaction(() => {
      // Hold the quoted amount up front; the difference is refunded on settle.
      this.ledger.charge(requesterId, priceMicro, job.id);
      this.db
        .prepare(
          `INSERT INTO jobs (id, status, requester_id, input, input_hash, attempts, price_micro, created_at, batch_id)
           VALUES (?,?,?,?,?,?,?,?,?)`,
        )
        .run(job.id, job.status, requesterId, JSON.stringify(input), inputHash, 0, priceMicro, job.createdAt, batchId ?? null);
    });
    tx();

    this.live.emit({ t: 'job.queued', jobId: job.id, workload: input.workload, model: input.model });
    this.dispatch();
    return job;
  }

  private validate(raw: Partial<JobInput>): JobInput {
    if (raw.workload === 'llm') {
      const messages = Array.isArray(raw.messages) ? raw.messages : [];
      if (messages.length === 0) throw new JobError(400, 'messages required');
      for (const m of messages) {
        if (!['system', 'user', 'assistant'].includes(m.role)) throw new JobError(400, 'bad message role');
        if (typeof m.content !== 'string') throw new JobError(400, 'message content must be a string');
      }
      const totalChars = messages.reduce((n, m) => n + m.content.length, 0);
      if (totalChars > 32_000) throw new JobError(413, 'prompt too long');
      return {
        workload: 'llm',
        billing: raw.billing === 'time' ? 'time' : 'tokens',
        maxSeconds: raw.billing === 'time' ? clamp(raw.maxSeconds ?? 60, 5, 3600) : undefined,
        model: String(raw.model ?? 'qwen2.5-0.5b-instruct'),
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        maxOutputTokens: clamp(raw.maxOutputTokens ?? 128, 1, 2048),
        temperature: clamp(raw.temperature ?? 0.7, 0, 2),
      };
    }
    if (raw.workload === 'compute') {
      return {
        workload: 'compute',
        billing: raw.billing === 'time' ? 'time' : 'tokens',
        maxSeconds: raw.billing === 'time' ? clamp(raw.maxSeconds ?? 60, 5, 3600) : undefined,
        model: 'hashchain-v1',
        seed: Math.floor(Number(raw.seed ?? Math.random() * 2 ** 31)),
        rounds: clamp(raw.rounds ?? 100_000, COMPUTE_MIN_ROUNDS, COMPUTE_MAX_ROUNDS),
      };
    }
    throw new JobError(400, "workload must be 'llm' or 'compute'");
  }

  // --- dispatch -----------------------------------------------------------

  /** Walk the queue oldest-first and hand each job to the cheapest idle node that can run it. */
  dispatch(): void {
    const queued = this.db
      .prepare("SELECT * FROM jobs WHERE status='queued' ORDER BY created_at ASC LIMIT 100")
      .all() as Array<Record<string, unknown>>;
    if (queued.length === 0) return;

    const taken = new Set<string>();
    for (const row of queued) {
      const job = rowToJob(row);
      const input = job.input;
      const cands = this.nodes
        .candidates(input.workload, input.model, promptChars(input), input.maxOutputTokens ?? 0)
        .filter((n) => !taken.has(n.id));
      if (cands.length === 0) continue;

      const node = pickCheapest(cands, input.billing === 'time');
      taken.add(node.id);
      const t = nowMs();
      this.db
        .prepare("UPDATE jobs SET status='assigned', node_id=?, lease_expires_at=?, assigned_at=?, attempts=attempts+1 WHERE id=? AND status='queued'")
        .run(node.id, t + LEASE_MS, t, job.id);
      this.nodes.setBusy(node.id, true);
      this.live.emit({ t: 'job.assigned', jobId: job.id, nodeId: node.id });
    }
  }

  /** What a node calls to pick up its work. Returns at most one job. */
  claim(nodeId: string): JobRecord | null {
    const row = this.db
      .prepare("SELECT * FROM jobs WHERE node_id=? AND status='assigned' ORDER BY assigned_at ASC LIMIT 1")
      .get(nodeId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const t = nowMs();
    this.db.prepare("UPDATE jobs SET status='running', started_at=?, lease_expires_at=? WHERE id=?").run(t, t + LEASE_MS, row.id);
    const job = rowToJob({ ...row, status: 'running', started_at: t });
    // The node needs the work, not who asked for it.
    return { ...job, requesterId: 'hidden' };
  }

  /**
   * Content retention. Prompts and replies are only needed until the
   * requester has read them; after that the hashes on the receipt are the
   * record. Runs on the housekeeping timer.
   */
  scrubContent(olderThanMs: number): number {
    const cutoff = nowMs() - olderThanMs;
    const rows = this.db
      .prepare("SELECT id, input, output FROM jobs WHERE status IN ('done','failed','cancelled') AND finished_at < ? AND scrubbed = 0")
      .all(cutoff) as Array<{ id: string; input: string; output: string | null }>;
    const upd = this.db.prepare('UPDATE jobs SET input=?, output=?, scrubbed=1 WHERE id=?');
    const tx = this.db.transaction(() => {
      for (const r of rows) {
        const input = JSON.parse(r.input) as JobInput;
        if (input.messages) input.messages = [{ role: 'user', content: `[removed after ${Math.round(olderThanMs / 60000)} min; ${input.messages.length} messages]` }];
        const output = r.output ? (JSON.parse(r.output) as JobOutput) : null;
        if (output?.text) output.text = '[removed]';
        upd.run(JSON.stringify(input), output ? JSON.stringify(output) : null, r.id);
      }
    });
    tx();
    return rows.length;
  }

  /** Called on a timer. Expired leases go back to the queue or fail out. */
  reapLeases(): void {
    const t = nowMs();
    const rows = this.db
      .prepare("SELECT * FROM jobs WHERE status IN ('assigned','running') AND lease_expires_at < ?")
      .all(t) as Array<Record<string, unknown>>;
    for (const row of rows) {
      const job = rowToJob(row);
      this.releaseJob(job, 'lease expired');
    }
    if (rows.length) this.dispatch();
  }

  /** When nodes go offline mid-job, give their jobs back. */
  releaseNodeJobs(nodeId: string): void {
    const rows = this.db
      .prepare("SELECT * FROM jobs WHERE node_id=? AND status IN ('assigned','running')")
      .all(nodeId) as Array<Record<string, unknown>>;
    for (const row of rows) this.releaseJob(rowToJob(row), 'node went offline');
    if (rows.length) this.dispatch();
  }

  private releaseJob(job: JobRecord, reason: string): void {
    if (job.nodeId) {
      this.nodes.recordFailed(job.nodeId);
      this.nodes.setBusy(job.nodeId, false);
    }
    if (job.attempts >= MAX_ATTEMPTS) {
      this.failJob(job, `${reason} (gave up after ${job.attempts} attempts)`);
      return;
    }
    this.db
      .prepare("UPDATE jobs SET status='queued', node_id=NULL, lease_expires_at=NULL, assigned_at=NULL, started_at=NULL WHERE id=?")
      .run(job.id);
    this.live.emit({ t: 'job.failed', jobId: job.id, nodeId: job.nodeId, reason: `${reason}, requeued` });
  }

  private failJob(job: JobRecord, reason: string): void {
    const tx = this.db.transaction(() => {
      this.db.prepare("UPDATE jobs SET status='failed', error=?, finished_at=? WHERE id=?").run(reason, nowMs(), job.id);
      this.ledger.post(job.requesterId, job.priceMicro, 'refund', job.id);
    });
    tx();
    this.live.emit({ t: 'job.failed', jobId: job.id, nodeId: job.nodeId, reason });
  }

  // --- completion ---------------------------------------------------------

  fail(nodeId: string, jobId: string, reason: string): void {
    const job = this.get(jobId);
    if (!job || job.nodeId !== nodeId || !['assigned', 'running'].includes(job.status)) {
      throw new JobError(409, 'job is not yours or not in progress');
    }
    this.releaseJob(job, reason.slice(0, 200));
    this.dispatch();
  }

  async complete(nodeId: string, jobId: string, output: JobOutput, body: ReceiptBody, nodeSig: string): Promise<Receipt> {
    const job = this.get(jobId);
    if (!job || job.nodeId !== nodeId || job.status !== 'running') {
      throw new JobError(409, 'job is not yours or not running');
    }
    const node = this.nodes.get(nodeId);
    if (!node) throw new JobError(404, 'unknown node');

    // 1. The receipt body must describe this job, as we recorded it.
    const outputHash = sha256Hex(job.input.workload === 'llm' ? String(output.text ?? '') : String(output.digest ?? ''));
    const expect: Partial<ReceiptBody> = {
      v: 1,
      jobId: job.id,
      nodeId: node.id,
      nodeClass: node.class,
      workload: job.input.workload,
      model: job.input.model,
      inputHash: job.inputHash,
      outputHash,
    };
    for (const [k, v] of Object.entries(expect)) {
      if ((body as unknown as Record<string, unknown>)[k] !== v) throw new JobError(400, `receipt field mismatch: ${k}`);
    }
    if (body.units !== output.units || body.outputTokens !== output.outputTokens) {
      throw new JobError(400, 'receipt counters do not match output');
    }

    // 2. The node must have actually signed it.
    const canon = canonical(body);
    if (!verify(canon, nodeSig, node.publicKey)) throw new JobError(400, 'bad node signature');

    // 3. Sanity-check the work. For compute we can re-run a sample and know for sure.
    const units = this.checkUnits(job, output);
    if (job.input.workload === 'compute' && (await this.spotCheckFails(job, output))) {
      this.nodes.recordFailed(nodeId);
      this.nodes.setBusy(nodeId, false);
      this.failJob(job, 'spot check failed: output digest did not match');
      throw new JobError(422, 'spot check failed');
    }

    // 4. Settle: charge actual usage, refund the rest of the hold, pay the node.
    //    Time billing uses the router's own clock between claim and completion,
    //    so a node can't bill for seconds it didn't hold the job.
    const costMicro = this.costFor(job, node, units);
    if (body.costMicro !== costMicro) {
      // Time billing: the node's clock and ours differ by a little. Accept the
      // node's figure if it's within a couple of seconds' worth and under the hold.
      const perHour = node.capabilities.pricePerHour ?? 20_000;
      const slack = Math.ceil((2 * perHour) / 3600) + 1;
      const ok = job.input.billing === 'time' && withFee(body.costMicro) <= job.priceMicro && Math.abs(body.costMicro - costMicro) <= slack;
      if (!ok) throw new JobError(400, `receipt cost mismatch (expected ${costMicro})`);
    }
    // The receipt carries the node's price (what the node signed and is paid);
    // the business is charged that plus the platform fee, never more than the hold.
    const settledMicro = body.costMicro;
    const chargedMicro = Math.min(job.priceMicro, withFee(settledMicro));
    const feeMicro = chargedMicro - settledMicro;

    const receipt: Receipt = {
      id: id('rcpt'),
      body,
      nodeSig,
      routerSig: sign(canon + '.' + nodeSig, this.routerKey.secretKey),
      routerKey: this.routerKey.publicKey,
      nodeKey: node.publicKey,
    };

    const t = nowMs();
    const tx = this.db.transaction(() => {
      this.db
        .prepare("UPDATE jobs SET status='done', output=?, cost_micro=?, finished_at=? WHERE id=?")
        .run(JSON.stringify({ ...output, units }), chargedMicro, t, job.id);
      const refund = job.priceMicro - chargedMicro;
      if (refund > 0) this.ledger.post(job.requesterId, refund, 'refund', job.id);
      this.ledger.post(this.nodes.accountId(nodeId), settledMicro, 'earn', job.id);
      if (feeMicro > 0) this.ledger.post(this.ledger.ensurePlatformAccount(), feeMicro, 'earn', job.id);
      this.nodes.recordDone(nodeId, units, settledMicro);
      if (job.input.workload === 'llm') this.nodes.observeThroughput(nodeId, output.outputTokens ?? 0, output.durationMs ?? 0);
      this.db
        .prepare(
          `INSERT INTO receipts (id, job_id, body, node_sig, router_sig, node_key, router_key, created_at)
           VALUES (?,?,?,?,?,?,?,?)`,
        )
        .run(receipt.id, job.id, canon, nodeSig, receipt.routerSig, node.publicKey, this.routerKey.publicKey, t);
    });
    tx();

    this.nodes.setBusy(nodeId, false);
    this.live.emit({
      t: 'job.done',
      jobId: job.id,
      nodeId,
      units,
      durationMs: t - (job.startedAt ?? job.createdAt),
      costMicro: settledMicro,
    });
    this.dispatch();
    return receipt;
  }

  /** What a finished job costs on this node: tokens × per-1k, or router-measured seconds × hourly. Never above the hold. */
  costFor(job: JobRecord, node: NodeRecord, units: number): number {
    if (job.input.billing === 'time') {
      const seconds = Math.max(1, Math.ceil((nowMs() - (job.startedAt ?? job.assignedAt ?? job.createdAt)) / 1000));
      const perHour = node.capabilities.pricePerHour ?? 20_000;
      return Math.min(nodeShareOf(job.priceMicro), Math.max(1, Math.ceil((seconds * perHour) / 3600)));
    }
    return Math.min(nodeShareOf(job.priceMicro), Math.max(1, Math.ceil((units * node.capabilities.pricePer1k) / 1000)));
  }

  private checkUnits(job: JobRecord, output: JobOutput): number {
    if (job.input.workload === 'llm') {
      const max = job.input.maxOutputTokens ?? 2048;
      // Don't trust the node's count beyond what the text could plausibly hold.
      const plausible = Math.ceil(String(output.text ?? '').length / 2) + 4;
      return Math.min(max, Math.max(1, Math.min(output.outputTokens, plausible)));
    }
    const rounds = job.input.rounds ?? 0;
    return Math.max(1, Math.ceil(rounds / COMPUTE_ROUNDS_PER_UNIT));
  }

  /** Re-run small compute jobs always, large ones one time in ten. */
  private async spotCheckFails(job: JobRecord, output: JobOutput): Promise<boolean> {
    const rounds = job.input.rounds ?? 0;
    const always = rounds <= 200_000;
    if (!always && Math.random() > 0.1) return false;
    const digest = await computeTask(job.input.seed ?? 0, rounds);
    return digest !== output.digest;
  }

  // --- reads --------------------------------------------------------------

  get(jobId: string): JobRecord | null {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as Record<string, unknown> | undefined;
    return row ? rowToJob(row) : null;
  }

  receipt(jobId: string): Receipt | null {
    const row = this.db.prepare('SELECT * FROM receipts WHERE job_id = ? OR id = ?').get(jobId, jobId) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return {
      id: row.id as string,
      body: JSON.parse(row.body as string),
      nodeSig: row.node_sig as string,
      routerSig: row.router_sig as string,
      nodeKey: row.node_key as string,
      routerKey: row.router_key as string,
    };
  }

  /** Most recent receipts on the router. Receipts carry hashes, not content, so this is public. */
  latestReceipts(limit = 10): Receipt[] {
    const rows = this.db.prepare('SELECT * FROM receipts ORDER BY created_at DESC LIMIT ?').all(limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: row.id as string,
      body: JSON.parse(row.body as string),
      nodeSig: row.node_sig as string,
      routerSig: row.router_sig as string,
      nodeKey: row.node_key as string,
      routerKey: row.router_key as string,
    }));
  }

  /** Operator view across every account, content stripped. */
  recentAll(limit = 50): JobRecord[] {
    const rows = this.db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?').all(limit) as Array<Record<string, unknown>>;
    return rows.map(rowToJob).map(withoutContent);
  }

  /**
   * A batch: many inputs, one id, one transaction. Either every item is
   * accepted and held for, or none is (so a batch can't half-charge you).
   */
  enqueueBatch(requesterId: string, items: Partial<JobInput>[], label?: string): { id: string; total: number; jobs: JobRecord[] } {
    const batchId = id('bat');
    const jobs: JobRecord[] = [];
    const tx = this.db.transaction(() => {
      this.db.prepare('INSERT INTO batches (id, requester_id, label, total, created_at) VALUES (?,?,?,?,?)').run(batchId, requesterId, label ?? null, items.length, nowMs());
      for (const it of items) jobs.push(this.enqueue(requesterId, it, batchId));
    });
    tx();
    return { id: batchId, total: items.length, jobs };
  }

  batch(requesterId: string, batchId: string): { id: string; label: string | null; total: number; createdAt: number; counts: Record<JobStatus, number>; costMicro: number; heldMicro: number } | null {
    const b = this.db.prepare('SELECT * FROM batches WHERE id=? AND requester_id=?').get(batchId, requesterId) as { id: string; label: string | null; total: number; created_at: number } | undefined;
    if (!b) return null;
    const rows = this.db.prepare('SELECT status, COUNT(*) AS n, COALESCE(SUM(cost_micro),0) AS cost, COALESCE(SUM(price_micro),0) AS held FROM jobs WHERE batch_id=? GROUP BY status').all(batchId) as Array<{ status: JobStatus; n: number; cost: number; held: number }>;
    const counts: Record<JobStatus, number> = { queued: 0, assigned: 0, running: 0, done: 0, failed: 0, cancelled: 0 };
    let costMicro = 0;
    let heldMicro = 0;
    for (const r of rows) {
      counts[r.status] = r.n;
      costMicro += r.cost;
      if (r.status !== 'done' && r.status !== 'failed') heldMicro += r.held;
    }
    return { id: b.id, label: b.label, total: b.total, createdAt: b.created_at, counts, costMicro, heldMicro };
  }

  batchJobs(requesterId: string, batchId: string): JobRecord[] {
    const rows = this.db.prepare('SELECT * FROM jobs WHERE batch_id=? AND requester_id=? ORDER BY created_at ASC').all(batchId, requesterId) as Array<Record<string, unknown>>;
    return rows.map(rowToJob);
  }

  batchesFor(requesterId: string, limit = 20): Array<{ id: string; label: string | null; total: number; createdAt: number }> {
    return (this.db.prepare('SELECT id, label, total, created_at AS createdAt FROM batches WHERE requester_id=? ORDER BY created_at DESC LIMIT ?').all(requesterId, limit) as Array<{ id: string; label: string | null; total: number; createdAt: number }>);
  }

  recentForRequester(requesterId: string, limit = 20): JobRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM jobs WHERE requester_id=? ORDER BY created_at DESC LIMIT ?')
      .all(requesterId, limit) as Array<Record<string, unknown>>;
    return rows.map(rowToJob);
  }

  /** A node's own history, with the customer's text removed. Operators see work, not content. */
  recentForNode(nodeId: string, limit = 20): JobRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM jobs WHERE node_id=? ORDER BY created_at DESC LIMIT ?')
      .all(nodeId, limit) as Array<Record<string, unknown>>;
    return rows.map(rowToJob).map(withoutContent);
  }

  /** Uptime in ms over the last 24h, from heartbeat gaps. Approximate; good enough for a dashboard. */
  nodeUptime24h(nodeId: string): number {
    const row = this.db.prepare('SELECT online_ms_24h FROM nodes WHERE id=?').get(nodeId) as { online_ms_24h: number } | undefined;
    return row?.online_ms_24h ?? 0;
  }

  /** Blocks (via polling) until a job is terminal or the timeout passes. Used by the OpenAI-style endpoint. */
  async waitFor(jobId: string, timeoutMs: number): Promise<JobRecord | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const job = this.get(jobId);
      if (!job) return null;
      if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') return job;
      await new Promise((r) => setTimeout(r, 250));
    }
    return this.get(jobId);
  }
}

// --- helpers ----------------------------------------------------------------

export function withoutContent(job: JobRecord): JobRecord {
  const input = { ...job.input };
  if (input.messages) {
    input.messages = undefined;
    (input as JobInput & { messageCount?: number }).messageCount = job.input.messages!.length;
  }
  const output = job.output ? { ...job.output, text: job.output.text === undefined ? undefined : '[hidden]' } : undefined;
  return { ...job, input, output, requesterId: 'hidden' };
}

function pickCheapest(cands: NodeRecord[], byTime = false): NodeRecord {
  // Cheapest first (by the price that applies to this job's billing), then
  // faster claimed throughput, then the one that's been waiting longest.
  const price = (n: NodeRecord) => (byTime ? n.capabilities.pricePerHour ?? Infinity : n.capabilities.pricePer1k);
  return [...cands].sort((a, b) => {
    const p = price(a) - price(b);
    if (p !== 0) return p;
    const s = (b.capabilities.tokensPerSec ?? 0) - (a.capabilities.tokensPerSec ?? 0);
    if (s !== 0) return s;
    return a.lastSeen - b.lastSeen;
  })[0];
}

function estimateUnits(input: JobInput): number {
  if (input.workload === 'llm') return input.maxOutputTokens ?? 128;
  return Math.ceil((input.rounds ?? 0) / COMPUTE_ROUNDS_PER_UNIT);
}

function promptChars(input: JobInput): number {
  return (input.messages ?? []).reduce((n, m) => n + m.content.length, 0);
}

function clamp(n: number, lo: number, hi: number): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}

export function rowToJob(r: Record<string, unknown>): JobRecord {
  return {
    id: r.id as string,
    status: r.status as JobStatus,
    requesterId: r.requester_id as string,
    input: JSON.parse(r.input as string),
    inputHash: r.input_hash as string,
    output: r.output ? JSON.parse(r.output as string) : undefined,
    nodeId: (r.node_id as string) ?? undefined,
    leaseExpiresAt: (r.lease_expires_at as number) ?? undefined,
    attempts: r.attempts as number,
    priceMicro: r.price_micro as number,
    costMicro: (r.cost_micro as number) ?? undefined,
    createdAt: r.created_at as number,
    assignedAt: (r.assigned_at as number) ?? undefined,
    startedAt: (r.started_at as number) ?? undefined,
    finishedAt: (r.finished_at as number) ?? undefined,
    error: (r.error as string) ?? undefined,
    batchId: (r.batch_id as string) ?? undefined,
  };
}
