import type { LiveEvent, NetworkStats, NodeClass, PublicNode, HardwareTier } from '@nightshift/shared';
import { TIER_LABEL } from '@nightshift/shared';
import { h, clear, tweenNumber, fmtMs, fmtUsd, fmtPerM, fmtHourly, timeHM, mountReveals } from '../lib/dom';
import { live } from '../lib/live';
import { api } from '../lib/api';
import { Globe } from '../lib/globe';
import type { Page } from '../main';

const CLASSES: { id: NodeClass; label: string; blurb: string }[] = [
  { id: 'browser', label: 'Browser tabs', blurb: 'People who opened the Earn page and pressed start.' },
  { id: 'native', label: 'Native', blurb: 'Terminals and servers running the worker script.' },
  { id: 'cloud', label: 'Cloud', blurb: 'Rented cards. Off on this router.' },
  { id: 'external', label: 'External models', blurb: 'Paid APIs behind an adapter. Off on this router.' },
];

export function networkPage(): Page {
  // --- map -------------------------------------------------------------
  const cols = new Map<NodeClass, { cells: HTMLElement; count: HTMLElement }>();
  const map = h('div', { class: 'map' });
  for (const c of CLASSES) {
    const cells = h('div', { class: 'cells' });
    const count = h('span', null, '0');
    cols.set(c.id, { cells, count });
    map.appendChild(h('div', { class: 'col' }, h('div', { class: 'col-h' }, h('b', null, c.label), count), cells, h('p', { class: 'small muted' }, c.blurb)));
  }
  const cellByNode = new Map<string, HTMLElement>();

  // --- hardware on the network, by class. Real counts; shows zeros honestly. ---
  const hw = h('div', { class: 'hw' });
  function rebuildHw(nodes: Iterable<PublicNode>): void {
    const tiers = Object.keys(TIER_LABEL) as HardwareTier[];
    const count = new Map<HardwareTier, PublicNode[]>(tiers.map((t) => [t, []]));
    for (const n of nodes) {
      const t = n.capabilities.hardware?.tier ?? (n.class === 'browser' ? 'cpu' : 'cpu');
      count.get(t)!.push(n);
    }
    hw.replaceChildren(
      ...tiers.map((t) => {
        const list = count.get(t)!;
        const names = Array.from(new Set(list.map((n) => n.capabilities.hardware?.gpu).filter(Boolean))) as string[];
        return h('div', { class: 'hw-tile', title: names.join(', ') }, h('b', null, String(list.length)), h('span', null, TIER_LABEL[t]), h('small', null, names.length ? names.slice(0, 2).join(', ') + (names.length > 2 ? ` +${names.length - 2}` : '') : list.length ? 'GPU not reported' : 'none online'));
      }),
    );
  }

  // --- the globe ----------------------------------------------------------
  const canvas = h('canvas', { class: 'console-field', 'aria-label': 'Globe of regions with nodes online; click a region to see its nodes' });
  const IDLE = 'Hover a region. Click one to fly in.';
  const readout = h('div', { class: 'console-readout' }, h('span', null, IDLE));
  const pinned = h('div', { class: 'console-pinned', hidden: true });
  const field = new Globe(canvas);
  field.onHover = (text) => {
    readout.firstElementChild!.textContent = text ?? (field.focus ? 'Hover a node. Click one to pin it. Esc to zoom out.' : IDLE);
  };
  field.onFocus = (region) => {
    readout.firstElementChild!.textContent = region ? 'Hover a node. Click one to pin it. Esc to zoom out.' : IDLE;
    if (!region) {
      pinned.hidden = true;
      return;
    }
    const busy = region.nodes.filter((n) => n.status === 'busy').length;
    const tiers = new Map<string, number>();
    for (const n of region.nodes) {
      const k = n.capabilities.hardware?.gpu ?? TIER_LABEL[n.capabilities.hardware?.tier ?? 'cpu'];
      tiers.set(k, (tiers.get(k) ?? 0) + 1);
    }
    pinned.hidden = false;
    pinned.replaceChildren(
      h('b', null, region.name),
      h('span', { class: 'tag' }, `${region.nodes.length} node${region.nodes.length === 1 ? '' : 's'} · ${busy} working`),
      h('div', { class: 'kv' }, ...Array.from(tiers.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8).flatMap(([k, v]) => [h('span', null, k), h('span', null, `×${v}`)])),
      h('p', { class: 'small muted' }, 'Regions are a metro area a node chose to share. Nothing finer is ever stored.'),
      h('button', { class: 'btn sm secondary', onClick: () => field.unfocus() }, 'All regions'),
    );
  };
  field.onClick = (id) => {
    const n = live.nodes.get(id);
    if (!n) return;
    pinned.hidden = false;
    pinned.replaceChildren(
      h('b', null, n.label),
      h('span', { class: 'tag' }, n.capabilities.hardware?.gpu ?? n.class),
      h('div', { class: 'kv' },
        h('span', null, 'status'), h('span', null, n.status),
        h('span', null, 'price'), h('span', null, `${fmtHourly(n.capabilities.pricePerHour)} · ${fmtPerM(n.capabilities.pricePer1k)} tokens`),
        h('span', null, 'jobs done'), h('span', null, String(n.jobsDone)),
        h('span', null, 'serves'), h('span', null, [...n.capabilities.workloads, ...n.capabilities.models].join(', ')),
        h('span', null, 'caps'), h('span', null, `${n.capabilities.maxOutputTokens} out · ${n.capabilities.maxPromptChars} chars`),
      ),
      h('button', { class: 'btn sm secondary', onClick: () => (pinned.hidden = true) }, 'Unpin'),
    );
  };
  const consoleEl = h('div', { class: 'console' }, canvas, readout, pinned);

  function rebuild(nodes: Iterable<PublicNode>): void {
    rebuildHw(Array.from(nodes));
    nodes = live.nodes.values();
    for (const { cells } of cols.values()) clear(cells);
    cellByNode.clear();
    const per = new Map<NodeClass, number>();
    for (const n of nodes) {
      const col = cols.get(n.class)!;
      const cell = h('div', { class: `cell ${n.status}`, title: `${n.label} · ${n.capabilities.hardware?.gpu ?? n.class} · ${n.jobsDone} done · $${((n.capabilities.pricePerHour ?? 0) / 1e6).toFixed(2)}/h` });
      col.cells.appendChild(cell);
      cellByNode.set(n.id, cell);
      per.set(n.class, (per.get(n.class) ?? 0) + 1);
    }
    for (const c of CLASSES) {
      const col = cols.get(c.id)!;
      const n = per.get(c.id) ?? 0;
      col.count.textContent = String(n);
      // Ghost cells keep the grid from collapsing when a class is empty.
      for (let i = n; i < 6; i++) col.cells.appendChild(h('div', { class: 'cell ghost' }));
    }
  }

  function flash(nodeId: string, cls: string, ms = 900): void {
    const cell = cellByNode.get(nodeId);
    if (!cell) return;
    cell.classList.add(cls);
    setTimeout(() => cell.classList.remove(cls), ms);
  }

  // --- counters --------------------------------------------------------
  const stat = (label: string) => {
    const n = h('div', { class: 'n' }, '—');
    return { el: h('div', null, n, h('div', { class: 'l' }, label)), n };
  };
  const sOnline = stat('nodes online');
  const sQueued = stat('queued');
  const sRunning = stat('running');
  const sP95 = stat('p95 turnaround, last hour');
  const sFloor = stat('cheapest model quote, per 1M tokens');
  const strip = h('div', { class: 'strip' }, sOnline.el, sQueued.el, sRunning.el, sP95.el, sFloor.el);

  function applyStats(s: NetworkStats): void {
    tweenNumber(sOnline.n, s.nodesOnline);
    tweenNumber(sQueued.n, s.jobsQueued);
    tweenNumber(sRunning.n, s.jobsRunning);
    tweenNumber(sP95.n, s.p95Ms, (n) => (s.jobsDone ? fmtMs(n) : '—'));
    tweenNumber(sFloor.n, s.floorPricePer1k ?? 0, (n) => (s.floorPricePer1k === null ? 'no model nodes' : `$${(n / 1000).toFixed(2)}/M`));
    pushSample(s.jobsDone);
  }

  // --- sparkline: jobs completed per 4 s tick ----------------------------
  const spark = h('canvas', { class: 'spark', width: 600, height: 56 });
  const samples: number[] = [];
  let lastDone: number | null = null;
  function pushSample(done: number): void {
    if (lastDone !== null) {
      samples.push(done - lastDone);
      if (samples.length > 60) samples.shift();
    }
    lastDone = done;
    drawSpark();
  }
  function drawSpark(): void {
    const ctx = spark.getContext('2d');
    if (!ctx) return;
    const w = spark.width;
    const hgt = spark.height;
    ctx.clearRect(0, 0, w, hgt);
    const max = Math.max(1, ...samples);
    const step = w / 59;
    ctx.strokeStyle = getComputedStyle(spark).getPropertyValue('--stamp') || '#2745d6';
    ctx.lineWidth = 2;
    ctx.beginPath();
    samples.forEach((v, i) => {
      const x = i * step;
      const y = hgt - 4 - (v / max) * (hgt - 8);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  // --- event feed -------------------------------------------------------
  const feedEl = h('div', { class: 'feed' });
  function log(kind: string, text: string): void {
    const row = h('div', null, h('span', { class: 't' }, timeHM(Date.now())), h('span', { class: `k ${kind}` }, kind), h('span', null, text));
    feedEl.prepend(row);
    while (feedEl.children.length > 80) feedEl.lastElementChild?.remove();
  }

  let greeted = false;
  const unsub = live.subscribe((ev: LiveEvent) => {
    field.apply(ev);
    switch (ev.t) {
      case 'hello':
        rebuild(ev.nodes);
        applyStats(ev.stats);
        if (!greeted) log('feed', `connected · ${ev.nodes.length} node${ev.nodes.length === 1 ? '' : 's'} online`);
        greeted = true;
        break;
      case 'stats':
        applyStats(ev.stats);
        break;
      case 'node.up':
        rebuild(live.nodes.values());
        log('node', `${ev.node.label} came online (${ev.node.capabilities.hardware?.gpu ?? ev.node.class}, ${fmtHourly(ev.node.capabilities.pricePerHour)})`);
        break;
      case 'node.down':
        rebuild(live.nodes.values());
        log('node', `${ev.nodeId.slice(0, 10)} went offline`);
        break;
      case 'node.busy': {
        const c = cellByNode.get(ev.nodeId);
        if (c) {
          c.classList.toggle('busy', ev.busy);
          c.classList.toggle('online', !ev.busy);
        }
        break;
      }
      case 'job.queued':
        log('queued', `${ev.jobId.slice(0, 12)} · ${ev.workload} · ${ev.model}`);
        break;
      case 'job.assigned':
        log('assigned', `${ev.jobId.slice(0, 12)} → ${live.nodes.get(ev.nodeId)?.label ?? ev.nodeId.slice(0, 10)}`);
        break;
      case 'job.done':
        flash(ev.nodeId, 'done');
        log('done', `${ev.jobId.slice(0, 12)} · ${ev.units} units · ${fmtMs(ev.durationMs)} · ${fmtUsd(ev.costMicro)}`);
        break;
      case 'job.failed':
        log('failed', `${ev.jobId.slice(0, 12)} · ${ev.reason}`);
        break;
    }
  });

  // Backfill the feed with the last few receipts so it isn't blank on arrival.
  api.latestReceipts().then(({ receipts }) => {
    for (const r of receipts.slice(0, 6).reverse()) {
      const row = h('div', null, h('span', { class: 't' }, timeHM(r.body.finishedAt)), h('span', { class: 'k done' }, 'done'), h('span', null, `${r.body.jobId.slice(0, 12)} · ${r.body.units} units · ${fmtMs(r.body.finishedAt - r.body.startedAt)} · ${fmtUsd(r.body.costMicro)}`));
      feedEl.appendChild(row);
    }
  }).catch(() => {});

  const el = h(
    'div',
    { class: 'container section' },
    h('div', { class: 'section-head reveal' }, h('h1', null, 'The network, right now'), h('p', null, 'Every lit point is a metro area with nodes reporting to this router. Blue packets are jobs going out, green ones are signed receipts coming back. Drag to spin, click a region to fly in.')),
    h('div', { class: 'reveal', 'data-delay': '1' }, strip),
    h('div', { class: 'reveal', 'data-delay': '2', style: { marginTop: '24px' } }, consoleEl),
    h('div', { class: 'card reveal', 'data-delay': '2', style: { marginTop: '24px' } }, h('h3', { style: { marginBottom: '4px' } }, 'Hardware online'), h('p', { class: 'small muted', style: { marginBottom: '12px' } }, 'Nodes by class, as they reported themselves on registration. Hover a tile for the GPU names.'), hw),
    h('div', { class: 'card reveal', 'data-delay': '2', style: { marginTop: '24px' } }, map),
    h(
      'div',
      { class: 'grid-2 reveal', 'data-delay': '3', style: { marginTop: '24px' } },
      h('div', { class: 'card' }, h('h3', null, 'Throughput'), h('p', { class: 'small muted', style: { margin: '4px 0 12px' } }, 'Jobs completed per tick, last four minutes.'), spark),
      h('div', { class: 'card' }, h('h3', { style: { marginBottom: '12px' } }, 'Events'), feedEl.children.length ? feedEl : feedEl),
    ),
  );
  const stopReveal = mountReveals(el);

  return { el, title: 'Network', unmount: () => { unsub(); stopReveal(); field.destroy(); } };
}
