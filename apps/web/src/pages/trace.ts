// "Follow one call" — eight steps, one figure. Clicking a step or scrolling
// past it changes which parts of the figure are lit.

import { h, prefersReducedMotion } from '../lib/dom';
import { TraceScene } from '../lib/tracescene';

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

export function traceSection(): HTMLElement {
  const canvas = h('canvas', { class: 'trace-canvas', 'aria-label': 'Animated figure of a request moving from your app through the router to a machine and back as a signed receipt' });
  const scene = new TraceScene(canvas);
  const note = h('p', { class: 'stage-note' });
  const stage = h('div', { class: 'trace-stage' }, h('div', { class: 'card flush trace-card' }, canvas, note));

  let active = -1;
  const stepEls: HTMLElement[] = [];
  const reduced = prefersReducedMotion();
  let lastUserAction = 0;

  function setStep(i: number, byUser = false): void {
    if (byUser) lastUserAction = performance.now();
    if (i === active) return;
    active = i;
    stepEls.forEach((el, j) => el.classList.toggle('is-active', j === i));
    note.textContent = STEPS[i].note;
    scene.setStep(i);
  }

  // Walk through on its own until the person takes over.
  let timer: number | undefined;
  function autoplay(on: boolean): void {
    clearInterval(timer);
    if (!on || reduced) return;
    timer = window.setInterval(() => {
      if (performance.now() - lastUserAction < 9000) return;
      setStep((active + 1) % STEPS.length);
    }, 3600);
  }

  const list = h('div', { class: 'trace-steps' });
  STEPS.forEach((s, i) => {
    const el = h(
      'div',
      {
        class: 'trace-step',
        role: 'button',
        tabindex: 0,
        onClick: () => setStep(i, true),
        onKeydown: (e: KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') setStep(i, true);
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setStep((i + 1) % STEPS.length, true);
            stepEls[(i + 1) % STEPS.length].focus();
          }
          if (e.key === 'ArrowUp') {
            e.preventDefault();
            setStep((i + STEPS.length - 1) % STEPS.length, true);
            stepEls[(i + STEPS.length - 1) % STEPS.length].focus();
          }
        },
      },
      h('span', { class: 'num' }, String(i + 1)),
      h('div', null, h('h3', null, s.title), h('p', null, s.body)),
    );
    stepEls.push(el);
    list.appendChild(el);
  });

  // Scroll follows along (and counts as the person steering) unless motion is reduced.
  if (!reduced) {
    const io = new IntersectionObserver(
      (entries) => {
        for (const en of entries) {
          if (en.isIntersecting) setStep(stepEls.indexOf(en.target as HTMLElement), true);
        }
      },
      { rootMargin: '-40% 0px -45% 0px', threshold: 0 },
    );
    stepEls.forEach((el) => io.observe(el));
  }

  setStep(0);

  const section = h(
    'section',
    { class: 'section', id: 'how' },
    h(
      'div',
      { class: 'container' },
      h('div', { class: 'section-head reveal' }, h('h2', null, 'Follow one call to its receipt'), h('p', null, 'Eight steps from your request to a signed receipt and a paid node. Click a step, or just scroll.')),
      h('div', { class: 'trace reveal', 'data-delay': '1' }, list, stage),
    ),
  );
  new IntersectionObserver(([e]) => autoplay(e.isIntersecting), { threshold: 0.2 }).observe(section);
  return section;
}
