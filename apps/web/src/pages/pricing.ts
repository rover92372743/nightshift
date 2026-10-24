import type { LiveEvent } from '@docket/shared';
import { PRICE_FLOOR_PER_1K, FREE_GRANT_MICRO } from '@docket/shared';
import { h, mountReveals, fmtCr } from '../lib/dom';
import { live } from '../lib/live';
import type { Page } from '../main';

export function pricingPage(): Page {
  const floor = h('div', { class: 'price-big' }, '—', h('small', null, 'µcr per 1k tokens, right now'));
  const floorNote = h('p', { class: 'muted' }, 'The cheapest llm quote on the network. It moves as nodes come and go.');

  let currentFloor = PRICE_FLOOR_PER_1K;
  const unsub = live.subscribe((ev: LiveEvent) => {
    if (ev.t === 'hello' || ev.t === 'stats') {
      const f = ev.stats.floorPricePer1k;
      floor.firstChild!.textContent = f === null ? 'no nodes' : String(f);
      floorNote.textContent = f === null ? 'No llm node is online, so there is no quote. Jobs are accepted at the floor and wait.' : `${ev.stats.nodesOnline} node${ev.stats.nodesOnline === 1 ? '' : 's'} online. The cheapest one sets this number.`;
      currentFloor = f ?? PRICE_FLOOR_PER_1K;
      recompute();
    }
  });

  // --- what each class tends to cost: bars that grow in when scrolled to ---
  const bands: [string, number, number, string][] = [
    ['Browser tabs', 200, 320, 'A tab costs nothing to keep open, so this is the floor in practice.'],
    ['Native', 350, 750, 'Someone\u2019s electricity. Faster, bigger models, a few times the price.'],
    ['Cloud', 1500, 4000, 'Rented cards. Off on this router; shown for scale.'],
  ];
  const bars = h('div', { class: 'bands' }, bands.map(([name, lo, hi, note]) =>
    h('div', { class: 'band' },
      h('div', { class: 'band-h' }, h('b', null, name), h('span', { class: 'muted small' }, `${lo}\u2013${hi} \u00b5cr/1k`)),
      h('div', { class: 'band-track' }, h('i', { style: `--lo:${(lo / 4000) * 100}%;--hi:${(hi / 4000) * 100}%` })),
      h('p', { class: 'small muted' }, note),
    ),
  ));
  new IntersectionObserver(([e]) => e.isIntersecting && bars.classList.add('in'), { threshold: 0.3 }).observe(bars);

  // --- calculator ---
  const reqs = h('input', { type: 'range', min: 10, max: 5000, step: 10, value: 500 }) as HTMLInputElement;
  const toks = h('input', { type: 'range', min: 16, max: 1024, step: 16, value: 160 }) as HTMLInputElement;
  const reqsOut = h('span', null, '500');
  const toksOut = h('span', null, '160');
  const total = h('output', null, '—');
  const totalNote = h('p', { class: 'small muted' });
  function recompute(): void {
    const r = Number(reqs.value);
    const t = Number(toks.value);
    reqsOut.textContent = String(r);
    toksOut.textContent = String(t);
    const micro = Math.ceil((r * t * currentFloor) / 1000);
    total.textContent = `${fmtCr(micro, 2)}`;
    totalNote.textContent = `${r} requests × ${t} output tokens at ${currentFloor} µcr/1k. You are charged for tokens that came back, so real spend is usually lower.`;
  }
  reqs.addEventListener('input', recompute);
  toks.addEventListener('input', recompute);
  recompute();

  const el = h(
    'div',
    { class: 'container section' },
    h('div', { class: 'section-head reveal' }, h('h1', null, 'Pricing'), h('p', null, 'Nodes name their price. The router routes to the cheapest one that can do the job, and charges you only for what came back.')),
    h(
      'div',
      { class: 'grid-2 reveal', 'data-delay': '1' },
      h('div', { class: 'card', style: { display: 'grid', gap: '14px' } }, floor, floorNote),
      h(
        'div',
        { class: 'card calc' },
        h('h3', null, 'What would a month cost?'),
        h('label', { class: 'field' }, h('span', null, h('span', null, 'Requests per month: '), reqsOut), reqs),
        h('label', { class: 'field' }, h('span', null, h('span', null, 'Output tokens per request: '), toksOut), toks),
        total,
        totalNote,
      ),
    ),
    h('div', { class: 'card reveal', 'data-delay': '2', style: { marginTop: '24px' } }, h('h3', { style: { marginBottom: '14px' } }, 'What each kind of node tends to ask'), bars),
    h(
      'div',
      { class: 'card reveal', 'data-delay': '2', style: { marginTop: '24px' } },
      h('h3', { style: { marginBottom: '12px' } }, 'How a job is priced'),
      h(
        'table',
        { class: 'table' },
        h('thead', null, h('tr', null, h('th', null, 'Step'), h('th', null, 'What happens'), h('th', null, 'Amount'))),
        h(
          'tbody',
          null,
          h('tr', null, h('td', null, 'Quote'), h('td', null, 'Max output tokens × the cheapest capable node’s price'), h('td', null, 'held')),
          h('tr', null, h('td', null, 'Run'), h('td', null, 'The node reports how many tokens it produced; the router caps that at what the text could hold'), h('td', null, '—')),
          h('tr', null, h('td', null, 'Settle'), h('td', null, 'Actual tokens × that node’s price. The rest of the hold is refunded'), h('td', null, 'charged')),
          h('tr', null, h('td', null, 'Pay'), h('td', null, 'The same amount lands in the node’s ledger as earnings'), h('td', null, 'paid')),
        ),
      ),
      h('p', { class: 'small muted', style: { marginTop: '12px' } }, `Floor price is ${PRICE_FLOOR_PER_1K} µcr per 1k. New anonymous sessions get ${fmtCr(FREE_GRANT_MICRO, 2)} to try things. One credit is one million micro-credits. Credits are a unit of account on this router; they are not a currency and nothing here promises a yield.`),
    ),
    h(
      'div',
      { class: 'grid-3 reveal', 'data-delay': '3', style: { marginTop: '24px' } },
      h('div', { class: 'card' }, h('h3', null, 'Browser nodes'), h('p', { class: 'muted', style: { marginTop: '8px' } }, 'Someone’s tab. Cheapest, because a tab costs nothing to keep open. Small models only.')),
      h('div', { class: 'card' }, h('h3', null, 'Native nodes'), h('p', { class: 'muted', style: { marginTop: '8px' } }, 'The worker script on a laptop or server. Bring your own model runtime and set a price that covers the electricity.')),
      h('div', { class: 'card' }, h('h3', null, 'Cloud and external'), h('p', { class: 'muted', style: { marginTop: '8px' } }, 'Rented cards and paid APIs behind an adapter. Off by default; never reachable on the free allowance.')),
    ),
  );
  const stopReveal = mountReveals(el);
  return { el, title: 'Pricing', unmount: () => { unsub(); stopReveal(); } };
}
