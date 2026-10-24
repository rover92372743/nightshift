import type { Db } from '../db/index.js';
import type { NetworkStats, NodeClass } from '@docket/shared';

export function networkStats(db: Db): NetworkStats {
  const byClass: Record<NodeClass, number> = { browser: 0, native: 0, cloud: 0, external: 0 };
  const nodeRows = db
    .prepare("SELECT class, COUNT(*) AS n FROM nodes WHERE status != 'offline' GROUP BY class")
    .all() as Array<{ class: NodeClass; n: number }>;
  let nodesOnline = 0;
  for (const r of nodeRows) {
    byClass[r.class] = r.n;
    nodesOnline += r.n;
  }

  const counts = db
    .prepare('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status')
    .all() as Array<{ status: string; n: number }>;
  const c = (s: string) => counts.find((r) => r.status === s)?.n ?? 0;

  const units = (db.prepare('SELECT COALESCE(SUM(units_verified),0) AS u FROM nodes').get() as { u: number }).u;

  const since = Date.now() - 3600_000;
  const lat = db
    .prepare("SELECT finished_at - created_at AS ms FROM jobs WHERE status='done' AND finished_at > ? ORDER BY ms ASC")
    .all(since) as Array<{ ms: number }>;
  const pct = (p: number) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(lat.length * p))].ms : 0);

  const floor = db
    .prepare(
      `SELECT MIN(json_extract(capabilities, '$.pricePer1k')) AS p FROM nodes
       WHERE status != 'offline' AND capabilities LIKE '%"llm"%'`,
    )
    .get() as { p: number | null };

  const done = c('done');
  const failed = c('failed');
  return {
    nodesOnline,
    nodesByClass: byClass,
    jobsQueued: c('queued'),
    jobsRunning: c('assigned') + c('running'),
    jobsDone: done,
    jobsFailed: failed,
    unitsVerified: units,
    successRate: done + failed === 0 ? 1 : done / (done + failed),
    p50Ms: pct(0.5),
    p95Ms: pct(0.95),
    floorPricePer1k: floor.p ?? null,
  };
}
