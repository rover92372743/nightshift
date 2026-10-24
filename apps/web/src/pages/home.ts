import type { LiveEvent, NetworkStats } from '@docket/shared';
import { h, tweenNumber, fmtInt, fmtMs, mountReveals, prefersReducedMotion, fmtCr } from '../lib/dom';
import { live } from '../lib/live';
import { api } from '../lib/api';
import { receiptEl, sampleReceipt } from '../lib/receipt';
import { traceSection } from './trace';
import type { Page } from '../main';

export function homePage(): Page {
  // --- hero with the printer -------------------------------------------
  const feed = h('div', { class: 'feed-slot' });
  const printer = h('div', { class: 'printer' }, h('div', { class: 'slot' }), h('div', { class: 'paper' }, feed));
  const caption = h('p', { class: 'caption' }, 'Waiting for the first job on the network.');
  let printing = false;
  let lastShown = '';

  function showReceiptForJob(jobId: string, verified: boolean): void {
    if (printing || jobId === lastShown) return;
    printing = true;
    lastShown = jobId;
    api
      .receipt(jobId)
      .then(({ receipt }) => {
        feed.replaceChildren(receiptEl(receipt, { compact: true }));
        printer.classList.remove('is-printing');
        void printer.offsetWidth; // restart the animation
        printer.classList.add('is-printing');
        const r = feed.firstElementChild as HTMLElement;
        const dur = prefersReducedMotion() ? 0 : 1400;
        setTimeout(() => verified && r.classList.add('is-verified'), dur + 100);
        caption.textContent = `Printed just now: ${receipt.body.workload === "llm" ? "an llm" : "a compute"} job on a ${receipt.body.nodeClass} node, ${fmtMs(receipt.body.finishedAt - receipt.body.startedAt)}, ${fmtCr(receipt.body.costMicro)}.`;
        setTimeout(() => (printing = false), dur + 600);
      })
      .catch(() => (printing = false));
  }

  // Start with the most recent real receipt if the network has one.
  const placeholder = receiptEl(sampleReceipt(), { compact: true });
  placeholder.classList.add('is-static');
  placeholder.style.opacity = '0.55';
  feed.appendChild(placeholder);

  // --- live strip ------------------------------------------------------
  const cell = (label: string) => {
    const n = h('div', { class: 'n' }, '—');
    return { el: h('div', null, n, h('div', { class: 'l' }, label)), n };
  };
  const cNodes = cell('nodes online');
  const cDone = cell('jobs completed');
  const cUnits = cell('work units verified');
  const cP50 = cell('median turnaround');
  const cRate = cell('success rate');
  const strip = h('div', { class: 'strip reveal', 'data-delay': '1' }, cNodes.el, cDone.el, cUnits.el, cP50.el, cRate.el);

  function applyStats(s: NetworkStats): void {
    tweenNumber(cNodes.n, s.nodesOnline);
    tweenNumber(cDone.n, s.jobsDone);
    tweenNumber(cUnits.n, s.unitsVerified);
    tweenNumber(cP50.n, s.p50Ms, (n) => (s.jobsDone ? fmtMs(n) : '—'));
    tweenNumber(cRate.n, s.successRate * 100, (n) => (s.jobsDone + s.jobsFailed ? `${n.toFixed(1)}%` : '—'));
  }

  const unsub = live.subscribe((ev: LiveEvent) => {
    if (ev.t === 'hello' || ev.t === 'stats') applyStats(ev.stats);
    if (ev.t === 'job.done') showReceiptForJob(ev.jobId, true);
  });

  const el = h(
    'div',
    null,
    h(
      'section',
      { class: 'hero' },
      h(
        'div',
        { class: 'container' },
        h(
          'div',
          null,
          h('h1', { class: 'reveal' }, 'Every answer comes with a receipt.'),
          h(
            'p',
            { class: 'lede reveal', 'data-delay': '1' },
            'Docket is one endpoint for inference. Each request runs on the cheapest machine that can take it, and comes back signed by the machine that ran it and by the router that checked it. Your own computer can be one of those machines.',
          ),
          h(
            'div',
            { class: 'actions reveal', 'data-delay': '2' },
            h('a', { class: 'btn', href: '/chat' }, 'Try it in the browser'),
            h('a', { class: 'btn secondary', href: '/earn' }, 'Put your computer to work'),
          ),
        ),
        h('div', { class: 'reveal', 'data-delay': '2' }, printer, caption),
      ),
    ),
    h('section', { class: 'section', style: { paddingTop: 0 } }, h('div', { class: 'container' }, strip, h('p', { class: 'small muted', style: { marginTop: '10px' } }, 'Live from this router. Nothing on this page is a sample.'))),
    traceSection(),
    h(
      'section',
      { class: 'section' },
      h(
        'div',
        { class: 'container' },
        h('div', { class: 'section-head reveal' }, h('h2', null, 'Two ways in')),
        h(
          'div',
          { class: 'grid-2 paths' },
          h(
            'div',
            { class: 'card reveal' },
            h('h3', null, 'Use the network'),
            h('p', { class: 'muted' }, 'Point an OpenAI-compatible client at the endpoint. You get a completion plus a receipt id you can check any time.'),
            h('ul', null, h('li', null, 'Same request and response shape you already use'), h('li', null, 'Pay only for tokens that came back; the hold is refunded'), h('li', null, 'Hard caps on prompt size and output length')),
            h('div', { class: 'row' }, h('a', { class: 'btn', href: '/docs/quickstart' }, 'Get a key'), h('a', { class: 'btn secondary', href: '/chat' }, 'Chat first')),
          ),
          h(
            'div',
            { class: 'card reveal', 'data-delay': '1' },
            h('h3', null, 'Power the network'),
            h('p', { class: 'muted' }, 'Open the Earn page and press start. The tab registers as a node, loads a small model, and takes jobs while it is in the foreground.'),
            h('ul', null, h('li', null, 'Your key stays in your browser; the router only sees signatures'), h('li', null, 'Set your own price and size limits; the router never forces a job on you'), h('li', null, 'Earnings post to your ledger on every receipt')),
            h('div', { class: 'row' }, h('a', { class: 'btn stamp', href: '/earn' }, 'Start a node'), h('a', { class: 'btn secondary', href: '/docs/run-a-node' }, 'Run one from a terminal')),
          ),
        ),
      ),
    ),
  );

  const stopReveal = mountReveals(el);

  // Seed the printer with the latest real receipt, if any.
  api
    .latestReceipts()
    .then(({ receipts }) => {
      if (receipts[0]) showReceiptForJob(receipts[0].body.jobId, true);
    })
    .catch(() => {});

  return {
    el,
    title: 'Docket',
    unmount() {
      unsub();
      stopReveal();
    },
  };
}

export { fmtInt };
