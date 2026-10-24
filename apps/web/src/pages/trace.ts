// "Follow one call" — eight steps, one figure. Clicking a step or scrolling
// past it changes which parts of the figure are lit.

import { h, svg, prefersReducedMotion } from '../lib/dom';

interface Step {
  title: string;
  body: string;
  note: string;
}

export const STEPS: Step[] = [
  { title: 'A request arrives', body: 'An OpenAI-style call hits /v1/chat/completions with a model name and messages. Same shape your client already sends.', note: 'The request is hashed; that hash ends up on the receipt.' },
  { title: 'Credits are held', body: 'The router quotes the job against the cheapest node that could take it right now and holds that amount. No balance, no job.', note: 'Anonymous sessions get a small allowance. Keys are topped up by the operator.' },
  { title: 'The cheapest capable node is picked', body: 'Every online, idle node that serves this model and fits the size limits is a candidate. Lowest price wins; claimed throughput breaks ties.', note: 'Browser tabs usually win because they are the cheapest thing to keep online.' },
  { title: 'The node collects the job', body: 'Nodes pull. The chosen node polls, signs the request with its key, and takes the job it was assigned. Nothing is pushed into a tab.', note: 'A node that disappears mid-job loses its lease and the job goes back in the queue.' },
  { title: 'The work runs', body: 'In a browser that means a small model on WebGPU; from a terminal it can be anything. The node reports a token count and a duration.', note: 'The router caps prompt size and output tokens so a job cannot run away.' },
  { title: 'The node signs a receipt', body: 'Job id, node id, hashes of input and output, timing and cost go into a fixed-shape body. The node signs its canonical form with ed25519.', note: 'Canonical JSON: sorted keys, no whitespace. Change one byte and the signature fails.' },
  { title: 'The router checks and countersigns', body: 'Field by field, the body has to match what the router recorded. Then the signature is checked. Compute jobs are re-run as a spot check.', note: 'The router adds its own signature over the body and the node signature together.' },
  { title: 'Everyone settles', body: 'Actual usage is charged, the unused part of the hold is refunded, and the node is credited. The receipt is stored and handed back.', note: 'Anyone with the receipt can verify it later without asking the router.' },
];

const FIG = `
<svg class="tf" viewBox="0 0 560 320" role="img" aria-label="Diagram of a request moving from the requester to the router to a node and back">
  <!-- requester -->
  <rect id="t-req" class="box" x="16" y="128" width="96" height="56" rx="8"/>
  <text x="64" y="151" text-anchor="middle">your app</text>
  <text x="64" y="167" text-anchor="middle" style="font-size:11px">POST /v1/…</text>
  <!-- router -->
  <rect id="t-router" class="box" x="196" y="112" width="128" height="88" rx="10"/>
  <text x="260" y="140" text-anchor="middle" style="font-weight:600;fill:var(--ink)">router</text>
  <text id="t-router-sub" x="260" y="158" text-anchor="middle" style="font-size:11px"></text>
  <text id="t-router-sub2" x="260" y="174" text-anchor="middle" style="font-size:11px"></text>
  <!-- ledger -->
  <rect id="t-ledger" class="box" x="214" y="232" width="92" height="40" rx="8"/>
  <text x="260" y="256" text-anchor="middle">ledger</text>
  <path id="w-ledger" class="wire" d="M260 200 V232"/>
  <!-- wires -->
  <path id="w-in" class="wire" d="M112 156 H196"/>
  <path id="w-out" class="wire" d="M196 156 H112" style="opacity:0"/>
  <path id="w-node" class="wire" d="M324 156 H372"/>
  <!-- node columns -->
  <g id="t-nodes">
    <text x="372" y="60">browser</text>
    <text x="420" y="60">native</text>
    <text x="468" y="60">cloud</text>
    <text x="516" y="60" style="font-size:11px">external</text>
  </g>
  <!-- receipt -->
  <g id="t-receipt" style="opacity:0;transition:opacity .4s">
    <path class="box" d="M372 236 h88 v62 l-5.5-4.5 -5.5 4.5 -5.5-4.5 -5.5 4.5 -5.5-4.5 -5.5 4.5 -5.5-4.5 -5.5 4.5 -5.5-4.5 -5.5 4.5 -5.5-4.5 -5.5 4.5 -5.5-4.5 -5.5 4.5 -5.5-4.5 -5.5 4.5 -5.5-4.5 -5.5 4.5 v-62z"/>
    <rect x="382" y="248" width="52" height="3" rx="1.5" fill="var(--ink-3)"/>
    <rect x="382" y="257" width="40" height="3" rx="1.5" fill="var(--ink-3)"/>
    <rect id="t-sig1" x="382" y="268" width="60" height="3" rx="1.5" fill="var(--stamp)" style="opacity:0"/>
    <rect id="t-sig2" x="382" y="277" width="60" height="3" rx="1.5" fill="var(--stamp)" style="opacity:0"/>
    <path id="w-receipt" class="wire" d="M372 156 V236" style="opacity:0"/>
  </g>
</svg>`;

const CLASSES = ['browser', 'native', 'cloud', 'external'];
const COUNTS = [12, 4, 0, 2];

export function traceSection(): HTMLElement {
  const fig = svg(FIG);
  const nodesG = fig.querySelector('#t-nodes')!;
  // Build node cells. One browser cell is "the chosen one".
  const cells: SVGRectElement[] = [];
  CLASSES.forEach((cls, ci) => {
    const x0 = 372 + ci * 48;
    for (let i = 0; i < 12; i++) {
      const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      const cx = x0 + (i % 3) * 13;
      const cy = 70 + Math.floor(i / 3) * 13;
      r.setAttribute('x', String(cx));
      r.setAttribute('y', String(cy));
      r.setAttribute('width', '10');
      r.setAttribute('height', '10');
      r.setAttribute('rx', '2');
      r.setAttribute('class', 'cell' + (i < COUNTS[ci] ? '' : ' dim'));
      r.dataset.cls = cls;
      r.dataset.i = String(i);
      nodesG.appendChild(r);
      cells.push(r);
    }
  });
  const chosen = cells.find((c) => c.dataset.cls === 'browser' && c.dataset.i === '4')!;
  const q = <T extends Element>(id: string) => fig.querySelector<T>('#' + id)!;

  const note = h('p', { class: 'stage-note' });
  const stage = h('div', { class: 'trace-stage' }, h('div', { class: 'card flush', style: { padding: '18px' } }, fig, note));

  let active = -1;
  const stepEls: HTMLElement[] = [];

  function setStep(i: number): void {
    if (i === active) return;
    active = i;
    stepEls.forEach((el, j) => el.classList.toggle('is-active', j === i));
    note.textContent = STEPS[i].note;

    const on = (id: string, v: boolean) => q(id).classList.toggle('on', v);
    const show = (id: string, v: boolean) => ((q<SVGElement>(id).style.opacity = v ? '1' : '0'));
    const sub = (a: string, b = '') => {
      q('t-router-sub').textContent = a;
      q('t-router-sub2').textContent = b;
    };

    on('t-req', i === 0 || i === 7);
    on('w-in', i === 0);
    on('t-router', i >= 1 && i <= 3 || i === 6 || i === 7);
    on('t-ledger', i === 1 || i === 7);
    on('w-ledger', i === 1 || i === 7);
    on('w-node', i === 3);
    show('w-out', i === 7);
    on('w-out', i === 7);
    show('t-receipt', i >= 5);
    show('w-receipt', i === 6);
    on('w-receipt', i === 6);
    show('t-sig1', i >= 5);
    show('t-sig2', i >= 6);

    cells.forEach((c) => c.classList.remove('lit'));
    if (i === 2) cells.filter((c) => !c.classList.contains('dim') && c.dataset.cls !== 'external').forEach((c) => c.classList.add('lit'));
    if (i >= 3 && i <= 5) chosen.classList.add('lit');

    const subs: [string, string][] = [
      ['hash input', ''],
      ['quote', 'hold credits'],
      ['rank candidates', 'by price'],
      ['assign', 'lease 90 s'],
      ['wait', ''],
      ['wait', ''],
      ['verify fields', 'check sig, countersign'],
      ['charge actual', 'refund rest, pay node'],
    ];
    sub(...subs[i]);
  }

  const list = h('div', { class: 'trace-steps' });
  STEPS.forEach((s, i) => {
    const el = h(
      'div',
      { class: 'trace-step', role: 'button', tabindex: 0, onClick: () => setStep(i), onKeydown: (e: KeyboardEvent) => (e.key === 'Enter' || e.key === ' ') && setStep(i) },
      h('span', { class: 'num' }, String(i + 1)),
      h('div', null, h('h3', null, s.title), h('p', null, s.body)),
    );
    stepEls.push(el);
    list.appendChild(el);
  });

  // Scroll follows along unless the user prefers reduced motion (then it's click-only).
  if (!prefersReducedMotion()) {
    const io = new IntersectionObserver(
      (entries) => {
        for (const en of entries) {
          if (en.isIntersecting) setStep(stepEls.indexOf(en.target as HTMLElement));
        }
      },
      { rootMargin: '-40% 0px -45% 0px', threshold: 0 },
    );
    stepEls.forEach((el) => io.observe(el));
  }

  setStep(0);

  return h(
    'section',
    { class: 'section', id: 'how' },
    h(
      'div',
      { class: 'container' },
      h('div', { class: 'section-head reveal' }, h('h2', null, 'Follow one call to its receipt'), h('p', null, 'Eight steps from your request to a signed receipt and a paid node. Click a step, or just scroll.')),
      h('div', { class: 'trace reveal', 'data-delay': '1' }, list, stage),
    ),
  );
}
