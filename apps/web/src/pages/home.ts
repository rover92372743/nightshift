import type { LiveEvent, NetworkStats } from '@docket/shared';
import { h, tweenNumber, fmtMs, mountReveals, prefersReducedMotion, fmtCr } from '../lib/dom';
import { live } from '../lib/live';
import { api, ApiError } from '../lib/api';
import { receiptEl, sampleReceipt, tilt } from '../lib/receipt';
import { Field, LIGHT } from '../lib/field';
import { traceSection } from './trace';
import { simulatorSection } from './simulator';
import type { Page } from '../main';

export function homePage(): Page {
  // --- the field behind the hero ------------------------------------------
  const canvas = h('canvas', { class: 'hero-field', 'aria-hidden': 'true' });
  const hoverTip = h('div', { class: 'field-tip', hidden: true });
  const field = new Field(canvas, LIGHT, { ghosts: 24, labels: false, interactive: true, center: [0.56, 0.5], spread: 1.15 });
  field.onHover = (n) => {
    hoverTip.hidden = !n;
    if (n) hoverTip.textContent = `${n.label} · ${n.cls} · ${n.jobs} done · ${n.price} µcr/1k`;
  };
  field.onClick = () => (location.href = '/network');
  canvas.addEventListener('pointermove', (e) => {
    hoverTip.style.left = `${e.clientX + 14}px`;
    hoverTip.style.top = `${e.clientY + 14}px`;
  });

  // --- receipt printer ----------------------------------------------------
  const feed = h('div', { class: 'feed-slot' });
  const printer = h('div', { class: 'printer' }, h('div', { class: 'slot' }), h('div', { class: 'paper' }, feed));
  const caption = h('p', { class: 'caption' }, 'Waiting for the first job on the network.');
  let printing = false;
  let lastShown = '';

  function showReceiptForJob(jobId: string): void {
    if (printing || jobId === lastShown) return;
    printing = true;
    lastShown = jobId;
    api
      .receipt(jobId)
      .then(({ receipt }) => {
        const rc = receiptEl(receipt, { compact: true });
        feed.replaceChildren(rc);
        tilt(rc);
        printer.classList.remove('is-printing');
        void printer.offsetWidth;
        printer.classList.add('is-printing');
        const dur = prefersReducedMotion() ? 0 : 1400;
        setTimeout(() => rc.classList.add('is-verified'), dur + 100);
        caption.textContent = `Printed just now: ${receipt.body.workload === 'llm' ? 'an llm' : 'a compute'} job on a ${receipt.body.nodeClass} node, ${fmtMs(receipt.body.finishedAt - receipt.body.startedAt)}, ${fmtCr(receipt.body.costMicro)}.`;
        setTimeout(() => (printing = false), dur + 600);
      })
      .catch(() => (printing = false));
  }

  const placeholder = receiptEl(sampleReceipt(), { compact: true });
  placeholder.classList.add('is-static');
  placeholder.style.opacity = '0.5';
  feed.appendChild(placeholder);

  // --- "send a test job": a real compute job from this session ------------
  const testBtn = h('button', { class: 'btn secondary' }, 'Send a test job') as HTMLButtonElement;
  const testNote = h('span', { class: 'small muted test-note' });
  testBtn.addEventListener('click', async () => {
    testBtn.disabled = true;
    testNote.textContent = 'Sending…';
    field.poke();
    try {
      const job = await api.submitJob({ workload: 'compute', rounds: 60_000 });
      testNote.textContent = `Queued ${job.id.slice(0, 12)}. Watch it travel.`;
    } catch (err) {
      testNote.textContent =
        err instanceof ApiError && err.status === 402 ? 'Your session is out of credits. Run a node for a minute and spend what it earns.' : 'Could not reach the router.';
    } finally {
      setTimeout(() => (testBtn.disabled = false), 2500);
    }
  });

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
  const strip = h('div', { class: 'strip reveal' }, cNodes.el, cDone.el, cUnits.el, cP50.el, cRate.el);

  function applyStats(s: NetworkStats): void {
    tweenNumber(cNodes.n, s.nodesOnline);
    tweenNumber(cDone.n, s.jobsDone);
    tweenNumber(cUnits.n, s.unitsVerified);
    tweenNumber(cP50.n, s.p50Ms, (n) => (s.jobsDone ? fmtMs(n) : '—'));
    tweenNumber(cRate.n, s.successRate * 100, (n) => (s.jobsDone + s.jobsFailed ? `${n.toFixed(1)}%` : '—'));
  }

  const unsub = live.subscribe((ev: LiveEvent) => {
    field.apply(ev);
    if (ev.t === 'hello' || ev.t === 'stats') applyStats(ev.stats);
    if (ev.t === 'job.done') setTimeout(() => showReceiptForJob(ev.jobId), 1500);
  });

  // --- headline: words rise one at a time ---------------------------------
  const words = 'Every answer comes with a receipt.'.split(' ');
  const h1 = h(
    'h1',
    { class: 'hero-title' },
    words.map((w, i) => h('span', { class: 'w', style: `--i:${i}` }, h('span', null, w))),
  );

  const el = h(
    'div',
    { class: 'home' },
    h(
      'section',
      { class: 'hero' },
      canvas,
      hoverTip,
      h(
        'div',
        { class: 'container hero-inner' },
        h(
          'div',
          { class: 'hero-copy' },
          h1,
          h(
            'p',
            { class: 'lede reveal', 'data-delay': '2' },
            'One endpoint for inference. Each request runs on the cheapest machine that can take it and comes back signed by that machine and by the router that checked it. The dots behind this text are the network, live.',
          ),
          h(
            'div',
            { class: 'actions reveal', 'data-delay': '3' },
            h('a', { class: 'btn', href: '/chat' }, 'Try the chat'),
            h('a', { class: 'btn stamp', href: '/earn' }, 'Put your computer to work'),
            testBtn,
          ),
          testNote,
        ),
        h('div', { class: 'hero-receipt reveal', 'data-delay': '3' }, printer, caption),
      ),
    ),
    h('section', { class: 'section', style: { paddingTop: 0 } }, h('div', { class: 'container' }, strip, h('p', { class: 'small muted', style: { marginTop: '10px' } }, 'Live from this router. Nothing on this page is a sample.'))),
    traceSection(),
    simulatorSection(),
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
  api
    .latestReceipts()
    .then(({ receipts }) => receipts[0] && showReceiptForJob(receipts[0].body.jobId))
    .catch(() => {});

  return {
    el,
    title: 'Docket',
    unmount() {
      unsub();
      stopReveal();
      field.destroy();
    },
  };
}
