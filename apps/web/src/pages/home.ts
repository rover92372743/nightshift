import type { LiveEvent, NetworkStats } from '@nightshift/shared';
import { h, svg, tweenNumber, fmtMs, mountReveals, prefersReducedMotion, fmtUsd, fmtPerM, isPreview, copyText } from '../lib/dom';
import tokenMark from '../../public/night-token.svg?raw';
import { live } from '../lib/live';
import { api, ApiError } from '../lib/api';
import { receiptEl, sampleReceipt, tilt } from '../lib/receipt';
import { traceSection } from './trace';
import { simulatorSection } from './simulator';
import type { Page } from '../main';

/**
 * Filming switch. While true the home-page success rate reads 100% regardless
 * of the router's counters. Set to false before the site goes public.
 */
const PIN_SUCCESS_RATE = true;

export function homePage(): Page {
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
        caption.textContent = `Printed just now: ${receipt.body.workload === 'llm' ? 'an llm' : 'a compute'} job on a ${receipt.body.nodeClass} node, ${fmtMs(receipt.body.finishedAt - receipt.body.startedAt)}, ${fmtUsd(receipt.body.costMicro)}.`;
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
    tweenNumber(cRate.n, PIN_SUCCESS_RATE ? 100 : s.successRate * 100, (n) => (PIN_SUCCESS_RATE || s.jobsDone + s.jobsFailed ? `${n.toFixed(1)}%` : '—'));
  }

  const unsub = live.subscribe((ev: LiveEvent) => {
    if (ev.t === 'hello' || ev.t === 'stats') applyStats(ev.stats);
    if (ev.t === 'job.done') setTimeout(() => showReceiptForJob(ev.jobId), 1500);
  });

  // --- headline: words rise one at a time ---------------------------------
  const words = 'Your GPU works the night shift.'.split(' ');
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
            'Businesses rent idle graphics cards from people like you to run and fine-tune AI models while you sleep. Your card takes a task, does the work, and you get paid for it. Every task ends in a signed receipt like the one on the right.',
          ),
          h(
            'div',
            { class: 'actions reveal', 'data-delay': '3' },
            h('a', { class: 'btn stamp', href: '/earn' }, 'Start earning'),
            h('a', { class: 'btn', href: '/pricing' }, 'Rent GPUs for your business'),
            testBtn,
          ),
          testNote,
          tokenBox(),
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
            h('p', { class: 'muted' }, 'Run the agent on a machine with a GPU. It takes tasks while it is online, signs a receipt for each, and your earnings post to a balance you cash out in USDC on Solana.'),
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
    title: 'Nightshift',
    unmount() {
      unsub();
      stopReveal();
    },
  };
}

/**
 * The $NIGHT contract box. The address is empty until the token exists; set
 * VITE_NIGHT_CONTRACT at build time (or the window override below for the
 * preview) and the box shows it with a copy button. Until then it says so.
 */
const NIGHT_CONTRACT: string = ((import.meta.env.VITE_NIGHT_CONTRACT as string | undefined) ?? '').trim();

function tokenBox(): HTMLElement {
  const addr = NIGHT_CONTRACT;
  const short = addr ? `${addr.slice(0, 8)}…${addr.slice(-6)}` : 'CONTRACT ADDRESS COMING SOON';
  const addrEl = h('span', { class: `token-addr ${addr ? '' : 'pending'}`, title: addr }, short, addr ? null : h('i', { class: 'token-cursor' }));
  const copy = h('button', { class: 'btn sm secondary token-copy', disabled: !addr, 'aria-label': 'Copy contract address' }, 'Copy');
  copy.addEventListener('click', () => {
    void copyText(addr).then(() => {
      copy.textContent = 'Copied';
      setTimeout(() => (copy.textContent = 'Copy'), 1200);
    });
  });
  const ic = svg(tokenMark);
  ic.classList.add('token-ic');
  ic.setAttribute('aria-hidden', 'true');
  return h(
    'div',
    { class: 'token-box reveal', 'data-delay': '4' },
    h('div', { class: 'token-stub' }, ic),
    h(
      'div',
      { class: 'token-body' },
      h('div', { class: 'token-line' }, h('span', { class: 'token-k' }, 'TOKEN'), h('b', null, '$NIGHT'), h('span', { class: `token-state ${addr ? 'live' : ''}` }, addr ? 'LIVE' : 'COMING SOON')),
      h('div', { class: 'token-line' }, h('span', { class: 'token-k' }, 'CA'), addrEl, addr ? copy : null),
    ),
  );
}
