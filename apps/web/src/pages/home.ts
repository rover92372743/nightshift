import type { LiveEvent, NetworkStats } from '@docket/shared';
import { h, tweenNumber, fmtMs, mountReveals, prefersReducedMotion, fmtCr, isPreview } from '../lib/dom';
import { live } from '../lib/live';
import { api, ApiError } from '../lib/api';
import { receiptEl, sampleReceipt, tilt } from '../lib/receipt';
import { Field, LIGHT } from '../lib/field';
import { traceSection } from './trace';
import { simulatorSection } from './simulator';
import { navigate } from '../lib/nav';
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
  field.onClick = () => navigate('/network');
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
  const cReg = cell('nodes registered');
  const cDone = cell('tasks completed');
  const cUnits = cell('work units verified');
  const cRate = cell('success rate');
  const strip = h('div', { class: 'strip reveal' }, cNodes.el, cReg.el, cDone.el, cUnits.el, cRate.el);

  function applyStats(s: NetworkStats): void {
    tweenNumber(cNodes.n, s.nodesOnline);
    tweenNumber(cReg.n, s.nodesRegistered);
    tweenNumber(cDone.n, s.jobsDone);
    tweenNumber(cUnits.n, s.unitsVerified);
    tweenNumber(cRate.n, s.successRate * 100, (n) => (s.jobsDone + s.jobsFailed ? `${n.toFixed(1)}%` : '—'));
  }

  const unsub = live.subscribe((ev: LiveEvent) => {
    field.apply(ev);
    if (ev.t === 'hello' || ev.t === 'stats') applyStats(ev.stats);
    if (ev.t === 'job.done') setTimeout(() => showReceiptForJob(ev.jobId), 1500);
  });

  // --- headline: words rise one at a time ---------------------------------
  const words = 'GPU swarms, with receipts.'.split(' ');
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
            'Businesses send batches of work to one endpoint. The router spreads them across independent GPUs, verifies what comes back, and signs a receipt for every task. The dots behind this text are the network, live.',
          ),
          h(
            'div',
            { class: 'actions reveal', 'data-delay': '3' },
            h('a', { class: 'btn', href: '/pricing' }, 'Rent GPU capacity'),
            h('a', { class: 'btn stamp', href: '/earn' }, 'Earn with your GPU'),
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
            h('h3', null, 'For businesses'),
            h('p', { class: 'muted' }, 'Point an OpenAI-compatible client at the endpoint, or send a batch. Work is spread across the swarm and every task comes back with a signed receipt naming the machine that ran it.'),
            h('ul', null, h('li', null, 'Pay per task, by hardware class; no idle GPU bills'), h('li', null, 'Compute tasks are re-run as spot checks; results you can prove'), h('li', null, 'Task text is wiped from the router ten minutes after completion')),
            h('div', { class: 'row' }, h('a', { class: 'btn', href: '/pricing' }, 'See pricing'), h('a', { class: 'btn secondary', href: '/docs/api' }, 'API reference')),
          ),
          h(
            'div',
            { class: 'card reveal', 'data-delay': '1' },
            h('h3', null, 'For node operators'),
            h('p', { class: 'muted' }, 'Run the agent on a machine with a GPU. It takes tasks while it is online, signs a receipt for each, and your earnings post to a balance you can cash out in SOL or USDC from $50.'),
            h('ul', null, h('li', null, 'Paid per task, at a rate set by your hardware class'), h('li', null, 'You never see task content; the agent processes it and forgets it'), h('li', null, 'Your key is your account; it never leaves your machine')),
            h('div', { class: 'row' }, h('a', { class: 'btn stamp', href: '/earn' }, 'Start earning'), h('a', { class: 'btn secondary', href: '/docs/earning' }, 'How earnings work')),
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
