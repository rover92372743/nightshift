import type { Db } from '../db/index.js';
import { id, nowMs } from '../db/index.js';
import type { BenchResult, BenchTicket, HardwareTier, NodeCapabilities, NodeClass, NodeRecord, PublicNode, Workload } from '@nightshift/shared';
import { OFFLINE_AFTER_MS, PRICE_FLOOR_PER_1K, HOURLY_SUGGESTED, tierForVram, isRegion, verifyBench, tierForScore, TOKENS_TIERS, BENCH_TICKET_TTL_MS } from '@nightshift/shared';
import { randomBytes } from 'node:crypto';
import type { Live } from './live.js';
import type { Ledger } from './ledger.js';

const CLASSES: NodeClass[] = ['browser', 'native', 'cloud', 'external'];
const WORKLOADS: Workload[] = ['llm', 'compute'];

export class Nodes {
  constructor(private db: Db, private live: Live, private ledger: Ledger) {}

  register(input: {
    class: NodeClass;
    label: string;
    publicKey: string;
    capabilities: NodeCapabilities;
    /** True from read-only tools (the CLI): find the node for this key without touching its settings. */
    lookupOnly?: boolean;
    /** Required for a key the router has not seen. Sets the tier. */
    benchmark?: BenchResult;
  }): NodeRecord {
    const existing = this.db.prepare('SELECT id FROM nodes WHERE public_key = ?').get(input.publicKey) as
      | { id: string }
      | undefined;
    if (input.lookupOnly) {
      if (!existing) throw new Error('no node registered with this key; run the worker first');
      return this.get(existing.id)!;
    }

    const caps = sanitiseCaps(input.capabilities);
    if (!CLASSES.includes(input.class)) throw new Error('bad node class');

    const t = nowMs();
    // A measured tier beats a claimed one. New keys must measure; a key the
    // router already knows keeps its last measurement unless it brings a new one.
    let bench: NodeRecord['benchmark'] | undefined;
    if (input.benchmark) bench = this.consumeBenchmark(input.benchmark, t);
    else if (existing) bench = this.get(existing.id)?.benchmark;
    else throw new Error('benchmark required: fetch a ticket from /v1/benchmark/ticket, run it, and register with the result');
    if (bench) {
      caps.hardware = { ...(caps.hardware ?? {}), tier: bench.tier, gpu: caps.hardware?.gpu ?? bench.gpu };
      if (input.capabilities.pricePerHour === undefined) caps.pricePerHour = HOURLY_SUGGESTED[bench.tier];
    }

    if (existing) {
      // Same key coming back: treat as a reconnect, keep the counters.
      this.db
        .prepare(
          'UPDATE nodes SET label=?, class=?, capabilities=?, status=?, last_seen=?, benchmark=? WHERE id=?',
        )
        .run(input.label.slice(0, 48), input.class, JSON.stringify(caps), 'online', t, bench ? JSON.stringify(bench) : null, existing.id);
      const node = this.get(existing.id)!;
      this.live.emit({ t: 'node.up', node: toPublic(node) });
      return node;
    }

    const nodeId = id('nd');
    const accountId = this.ledger.ensureNodeAccount(nodeId);
    this.db
      .prepare(
        `INSERT INTO nodes (id, account_id, class, label, public_key, capabilities, status, last_seen, created_at, benchmark)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(nodeId, accountId, input.class, input.label.slice(0, 48), input.publicKey, JSON.stringify(caps), 'online', t, t, bench ? JSON.stringify(bench) : null);
    const node = this.get(nodeId)!;
    this.live.emit({ t: 'node.up', node: toPublic(node) });
    return node;
  }

  // --- benchmark tickets ----------------------------------------------------

  issueTicket(): BenchTicket {
    const ticket: BenchTicket = { id: id('bt'), nonce: randomBytes(4).readUInt32LE(0), issuedAt: nowMs() };
    this.db.prepare('INSERT INTO bench_tickets (id, nonce, issued_at) VALUES (?,?,?)').run(ticket.id, ticket.nonce, ticket.issuedAt);
    // sweep old ones now and then
    if (ticket.nonce % 32 === 0) this.db.prepare('DELETE FROM bench_tickets WHERE issued_at < ?').run(ticket.issuedAt - BENCH_TICKET_TTL_MS * 2);
    return ticket;
  }

  /** Check a result against its ticket, burn the ticket, return what to store. Throws with a plain reason. */
  private consumeBenchmark(r: BenchResult, now: number): NonNullable<NodeRecord['benchmark']> {
    const row = this.db.prepare('SELECT id, nonce, issued_at AS issuedAt, used_at AS usedAt FROM bench_tickets WHERE id = ?').get(String(r.ticketId)) as
      | { id: string; nonce: number; issuedAt: number; usedAt: number | null }
      | undefined;
    if (!row) throw new Error('unknown benchmark ticket');
    if (row.usedAt) throw new Error('benchmark ticket already used');
    const { tier, score } = verifyBench({ id: row.id, nonce: row.nonce, issuedAt: row.issuedAt }, r, now);
    this.db.prepare('UPDATE bench_tickets SET used_at=? WHERE id=?').run(now, row.id);
    return { kind: r.kind, score, tier, gpu: r.gpu ? String(r.gpu).slice(0, 64) : undefined, at: now };
  }

  /**
   * Real throughput, measured on jobs. An exponential average of output
   * tokens per second; after ten jobs, if it says a lower tier than the one
   * on record, the tier comes down. Benchmarks can be gamed; a month of real
   * jobs cannot.
   */
  observeThroughput(nodeId: string, outputTokens: number, durationMs: number): void {
    if (!outputTokens || durationMs < 50) return;
    const tps = outputTokens / (durationMs / 1000);
    const n = this.get(nodeId);
    if (!n) return;
    const ema = n.tpsEma === undefined ? tps : n.tpsEma * 0.8 + tps * 0.2;
    this.db.prepare('UPDATE nodes SET tps_ema=? WHERE id=?').run(ema, nodeId);
    const measured = tierForScore(ema, TOKENS_TIERS);
    const current = n.capabilities.hardware?.tier ?? 'cpu';
    if (n.jobsDone >= 10 && rank(measured) < rank(current)) {
      const caps = { ...n.capabilities, hardware: { ...(n.capabilities.hardware ?? {}), tier: measured } };
      this.db.prepare('UPDATE nodes SET capabilities=? WHERE id=?').run(JSON.stringify(caps), nodeId);
    }
  }

  heartbeat(nodeId: string, busy: boolean): boolean {
    this.creditUptime(nodeId);
    const r = this.db
      .prepare("UPDATE nodes SET last_seen=?, status=? WHERE id=? AND status != 'offline'")
      .run(nowMs(), busy ? 'busy' : 'online', nodeId);
    if (r.changes === 0) {
      // Came back after we marked it offline. Bring it up again.
      const r2 = this.db.prepare('UPDATE nodes SET last_seen=?, status=? WHERE id=?').run(nowMs(), 'online', nodeId);
      if (r2.changes === 0) return false;
      this.live.emit({ t: 'node.up', node: toPublic(this.get(nodeId)!) });
    }
    return true;
  }

  setBusy(nodeId: string, busy: boolean): void {
    this.db.prepare("UPDATE nodes SET status=? WHERE id=? AND status != 'offline'").run(busy ? 'busy' : 'online', nodeId);
    this.live.emit({ t: 'node.busy', nodeId, busy });
  }

  /** Called on a timer. Anything quiet for too long goes offline and its leases get released by the router. */
  reap(): string[] {
    const cutoff = nowMs() - OFFLINE_AFTER_MS;
    const rows = this.db
      .prepare("SELECT id FROM nodes WHERE status != 'offline' AND last_seen < ?")
      .all(cutoff) as Array<{ id: string }>;
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    this.db.prepare(`UPDATE nodes SET status='offline' WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
    for (const nodeId of ids) this.live.emit({ t: 'node.down', nodeId });
    return ids;
  }

  get(nodeId: string): NodeRecord | null {
    const r = this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(nodeId) as Record<string, unknown> | undefined;
    return r ? rowToNode(r) : null;
  }

  online(): NodeRecord[] {
    const rows = this.db.prepare("SELECT * FROM nodes WHERE status != 'offline'").all() as Array<Record<string, unknown>>;
    return rows.map(rowToNode);
  }

  /** The set a job can land on: online, idle, serves the workload and model, within caps. */
  candidates(workload: Workload, model: string, promptChars: number, maxOut: number): NodeRecord[] {
    return this.online().filter((n) => {
      if (n.status !== 'online') return false;
      const c = n.capabilities;
      if (!c.workloads.includes(workload)) return false;
      if (workload === 'llm' && !c.models.includes(model)) return false;
      if (promptChars > c.maxPromptChars) return false;
      if (maxOut > c.maxOutputTokens) return false;
      return true;
    });
  }

  /**
   * Add the gap since the last heartbeat to today's uptime, capped at the
   * offline threshold so a reconnect after an hour doesn't count the hour.
   * The counter resets when the UTC day changes.
   */
  private creditUptime(nodeId: string): void {
    const row = this.db.prepare('SELECT last_seen, status, uptime_day FROM nodes WHERE id=?').get(nodeId) as
      | { last_seen: number; status: string; uptime_day: number }
      | undefined;
    if (!row || row.status === 'offline') return;
    const t = nowMs();
    const day = Math.floor(t / 86_400_000);
    const gap = Math.min(OFFLINE_AFTER_MS, Math.max(0, t - row.last_seen));
    if (row.uptime_day !== day) this.db.prepare('UPDATE nodes SET online_ms_24h=?, uptime_day=? WHERE id=?').run(gap, day, nodeId);
    else this.db.prepare('UPDATE nodes SET online_ms_24h=online_ms_24h+? WHERE id=?').run(gap, nodeId);
  }

  accountId(nodeId: string): string {
    return `nacct_${nodeId}`;
  }

  recordDone(nodeId: string, units: number, earnedMicro: number): void {
    this.db
      .prepare('UPDATE nodes SET jobs_done=jobs_done+1, units_verified=units_verified+?, earned_micro=earned_micro+? WHERE id=?')
      .run(units, earnedMicro, nodeId);
  }

  recordFailed(nodeId: string): void {
    this.db.prepare('UPDATE nodes SET jobs_failed=jobs_failed+1 WHERE id=?').run(nodeId);
  }
}

function sanitiseCaps(c: Partial<NodeCapabilities>): NodeCapabilities {
  const workloads = (c.workloads ?? []).filter((w): w is Workload => WORKLOADS.includes(w as Workload));
  if (workloads.length === 0) throw new Error('node must offer at least one workload');
  const tier = c.hardware?.tier ?? tierForVram(c.hardware?.vramGb);
  return {
    workloads,
    models: (c.models ?? []).map(String).slice(0, 16),
    pricePerHour: Math.max(10_000, Math.floor(c.pricePerHour ?? HOURLY_SUGGESTED[tier])),
    maxPromptChars: clamp(c.maxPromptChars ?? 4000, 256, 32_000),
    maxOutputTokens: clamp(c.maxOutputTokens ?? 256, 16, 2048),
    pricePer1k: Math.max(PRICE_FLOOR_PER_1K, Math.floor(c.pricePer1k ?? PRICE_FLOOR_PER_1K)),
    tokensPerSec: c.tokensPerSec ? clamp(c.tokensPerSec, 0.1, 5000) : undefined,
    hardware: c.hardware
      ? { gpu: c.hardware.gpu ? String(c.hardware.gpu).slice(0, 64) : undefined, vramGb: c.hardware.vramGb ? clamp(c.hardware.vramGb, 0, 1024) : undefined, tier: c.hardware.tier }
      : undefined,
    region: isRegion(c.region) ? c.region : undefined,
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Number(n) || lo));
}

export function rowToNode(r: Record<string, unknown>): NodeRecord {
  return {
    id: r.id as string,
    class: r.class as NodeClass,
    label: r.label as string,
    publicKey: r.public_key as string,
    capabilities: JSON.parse(r.capabilities as string),
    status: r.status as NodeRecord['status'],
    lastSeen: r.last_seen as number,
    createdAt: r.created_at as number,
    jobsDone: r.jobs_done as number,
    jobsFailed: r.jobs_failed as number,
    unitsVerified: r.units_verified as number,
    earnedMicro: r.earned_micro as number,
    benchmark: r.benchmark ? JSON.parse(r.benchmark as string) : undefined,
    tpsEma: (r.tps_ema as number) ?? undefined,
  };
}

const TIER_RANK: HardwareTier[] = ['cpu', 'gpu-8', 'gpu-16', 'gpu-24', 'gpu-48', 'gpu-80'];
function rank(t: HardwareTier): number {
  return TIER_RANK.indexOf(t);
}

export function toPublic(n: NodeRecord): PublicNode {
  return { id: n.id, class: n.class, label: n.label, status: n.status, capabilities: n.capabilities, jobsDone: n.jobsDone };
}
