import type { LiveEvent, NetworkStats, NodeClass, PublicNode } from '@docket/shared';
import { h, clear, tweenNumber, fmtMs, fmtCr, timeHM, mountReveals } from '../lib/dom';
import { live } from '../lib/live';
import { api } from '../lib/api';
import { Field, DARK } from '../lib/field';
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

  // --- the big live map -------------------------------------------------
  const canvas = h('canvas', { class: 'console-field', 'aria-label': 'Live map of nodes around the router' });
  const readout = h('div', { class: 'console-readout' }, h('span', null, 'Hover a node. Click one to pin it.'));
  const pinned = h('div', { class: 'console-pinned', hidden: true });
  const field = new Field(canvas, DARK, { ghosts: 0, labels: true, interactive: true, routerLabel: 'router' });
  field.onHover = (n) => {
    readout.firstElementChild!.textContent = n ? `${n.label} · ${n.cls} · ${n.jobs} done · ${n.price} µcr/1k` : 'Hover a node. Click one to pin it.';
  };
  field.onClick = (id) => {
    const n = live.nodes.get(id);
    if (!n) return;
    pinned.hidden = false;
    pinned.replaceChildren(
      h('b', null, n.label),
      h('span', { class: 'tag' }, n.class),
      h('div', { class: 'kv' },
        h('span', null, 'status'), h('span', null, n.status),
        h('span', null, 'price'), h('span', null, `${n.capabilities.pricePer1k} µcr/1k`),
        h('span', null, 'jobs done'), h('span', null, String(n.jobsDone)),
        h('span', null, 'serves'), h('span', null, [...n.capabilities.workloads, ...n.capabilities.models].join(', ')),
        h('span', null, 'caps'), h('span', null, `${n.capabilities.maxOutputTokens} out · ${n.capabilities.maxPromptChars} chars`),
      ),
      h('button', { class: 'btn sm secondary', onClick: () => (pinned.hidden = true) }, 'Unpin'),
    );
  };
  const consoleEl = h('div', { class: 'console' }, canvas, readout, pinned);

  function rebuild(nodes: Iterable<PublicNode>): void {
    for (const { cells } of cols.values()) clear(cells);
    cellByNode.clear();
    const per = new Map<NodeClass, number>();
    for (const n of nodes) {
      const col = cols.get(n.class)!;
      const cell = h('div', { class: `cell ${n.status}`, title: `${n.label} · ${n.jobsDone} done · ${n.capabilities.pricePer1k} µcr/1k` });
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
  const sFloor = stat('cheapest llm quote');
  const strip = h('div', { class: 'strip' }, sOnline.el, sQueued.el, sRunning.el, sP95.el, sFloor.el);

  function applyStats(s: NetworkStats): void {
    tweenNumber(sOnline.n, s.nodesOnline);
    tweenNumber(sQueued.n, s.jobsQueued);
    tweenNumber(sRunning.n, s.jobsRunning);
    tweenNumber(sP95.n, s.p95Ms, (n) => (s.jobsDone ? fmtMs(n) : '—'));
    tweenNumber(sFloor.n, s.floorPricePer1k ?? 0, (n) => (s.floorPricePer1k === null ? 'no llm nodes' : `${Math.round(n)} µcr/1k`));
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
        log('node', `${ev.node.label} came online (${ev.node.class}, ${ev.node.capabilities.pricePer1k} µcr/1k)`);
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
        log('done', `${ev.jobId.slice(0, 12)} · ${ev.units} units · ${fmtMs(ev.durationMs)} · ${fmtCr(ev.costMicro)}`);
        break;
      case 'job.failed':
        log('failed', `${ev.jobId.slice(0, 12)} · ${ev.reason}`);
        break;
    }
  });

  // Backfill the feed with the last few receipts so it isn't blank on arrival.
  api.latestReceipts().then(({ receipts }) => {
    for (const r of receipts.slice(0, 6).reverse()) {
      const row = h('div', null, h('span', { class: 't' }, timeHM(r.body.finishedAt)), h('span', { class: 'k done' }, 'done'), h('span', null, `${r.body.jobId.slice(0, 12)} · ${r.body.units} units · ${fmtMs(r.body.finishedAt - r.body.startedAt)} · ${fmtCr(r.body.costMicro)}`));
      feedEl.appendChild(row);
    }
  }).catch(() => {});

  const el = h(
    'div',
    { class: 'container section' },
    h('div', { class: 'section-head reveal' }, h('h1', null, 'The network, right now'), h('p', null, 'Every dot is a real node talking to this router. Blue packets are jobs going out, green ones are receipts coming back. Hover, click, watch.')),
    h('div', { class: 'reveal', 'data-delay': '1' }, strip),
    h('div', { class: 'reveal', 'data-delay': '2', style: { marginTop: '24px' } }, consoleEl),
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
