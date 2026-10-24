// Business pricing. Rates are per task output, by the hardware class that ran
// it, plus an optional reserved-capacity line for customers who want nodes
// held for them. The live floor at the top is what the network actually
// quotes right now.

import type { LiveEvent } from '@docket/shared';
import { PAYOUT_MIN_MICRO } from '@docket/shared';
import { h, mountReveals } from '../lib/dom';
import { live } from '../lib/live';
import { api } from '../lib/api';
import type { Page } from '../main';

// Published list rates, USD. One credit is one dollar. Node operators receive the
// share shown on the Earning doc; the difference funds verification and the router.
const RATES: { tier: string; label: string; per1k: number; examples: string; share: number }[] = [
  { tier: 'cpu', label: 'CPU nodes', per1k: 0.0004, examples: 'compute tasks, tiny models', share: 0.8 },
  { tier: 'gpu-8', label: 'GPU up to 8 GB', per1k: 0.0008, examples: '1–3B models, embeddings', share: 0.8 },
  { tier: 'gpu-16', label: 'GPU 12–16 GB', per1k: 0.0014, examples: '7–8B models, image generation', share: 0.8 },
  { tier: 'gpu-24', label: 'GPU 20–24 GB', per1k: 0.0022, examples: '13B models, quantised 30B', share: 0.8 },
  { tier: 'gpu-48', label: 'GPU 32–48 GB', per1k: 0.0040, examples: '30–34B models at full precision', share: 0.8 },
  { tier: 'gpu-80', label: 'GPU 80 GB+', per1k: 0.0070, examples: '70B models, long contexts', share: 0.8 },
];

export function pricingPage(): Page {
  const floor = h('div', { class: 'price-big' }, '—', h('small', null, 'µcr per 1k tokens, lowest live quote'));
  const floorNote = h('p', { class: 'muted' }, 'What the cheapest node on the network is asking right now. List rates below are what you are billed; the network is usually under them.');
  const unsub = live.subscribe((ev: LiveEvent) => {
    if (ev.t === 'hello' || ev.t === 'stats') {
      const f = ev.stats.floorPricePer1k;
      floor.firstChild!.textContent = f === null ? 'no llm nodes' : String(f);
      floorNote.textContent = f === null ? 'No language-model node is online right now. Jobs are accepted and wait.' : `${ev.stats.nodesOnline} node${ev.stats.nodesOnline === 1 ? '' : 's'} online, ${ev.stats.nodesRegistered} registered. The cheapest sets this number.`;
    }
  });

  // --- estimator ---
  const tier = h('select', { class: 'select' }, RATES.map((r) => h('option', { value: r.tier }, r.label))) as HTMLSelectElement;
  tier.value = 'gpu-16';
  const tasks = h('input', { type: 'range', min: 1000, max: 2_000_000, step: 1000, value: 100_000 }) as HTMLInputElement;
  const toks = h('input', { type: 'range', min: 32, max: 2048, step: 32, value: 256 }) as HTMLInputElement;
  const tasksOut = h('span', null, '100,000');
  const toksOut = h('span', null, '256');
  const total = h('output', null, '—');
  const totalNote = h('p', { class: 'small muted' });
  function recompute(): void {
    const r = RATES.find((x) => x.tier === tier.value)!;
    const n = Number(tasks.value);
    const t = Number(toks.value);
    tasksOut.textContent = n.toLocaleString();
    toksOut.textContent = String(t);
    const usd = (n * t * r.per1k) / 1000;
    total.textContent = `$${usd.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
    totalNote.textContent = `${n.toLocaleString()} tasks × ${t} output tokens on ${r.label.toLowerCase()} at $${r.per1k.toFixed(4)} per 1k. Billed on tokens returned; unused holds are refunded.`;
  }
  [tier, tasks, toks].forEach((c) => c.addEventListener('input', recompute));
  recompute();

  // --- quote form ---
  const qName = h('input', { class: 'input', placeholder: 'Company', id: 'q-company' }) as HTMLInputElement;
  const qEmail = h('input', { class: 'input', type: 'email', placeholder: 'Work email', id: 'q-email' }) as HTMLInputElement;
  const qNeed = h('textarea', { class: 'textarea', rows: 3, placeholder: 'What are you running? Models, volume, deadline.', id: 'q-need' }) as HTMLTextAreaElement;
  const qBtn = h('button', { class: 'btn', type: 'submit' }, 'Request a quote') as HTMLButtonElement;
  const qNote = h('p', { class: 'small muted' });
  const qForm = h(
    'form',
    { style: { display: 'grid', gap: '12px' }, onSubmit: async (e: Event) => {
      e.preventDefault();
      qBtn.disabled = true;
      try {
        await api.quote({ company: qName.value, email: qEmail.value, need: qNeed.value });
        qNote.textContent = 'Sent. You will hear back by email.';
        qForm.reset();
      } catch (err) {
        qNote.textContent = (err as Error).message;
      } finally {
        qBtn.disabled = false;
      }
    } },
    h('div', { class: 'grid-2', style: { gap: '12px' } }, qName, qEmail),
    qNeed,
    h('div', { class: 'row' }, qBtn),
    qNote,
  );

  const el = h(
    'div',
    { class: 'container section' },
    h('div', { class: 'section-head reveal' }, h('h1', null, 'Pricing for businesses'), h('p', null, 'Pay per task, by the class of hardware that ran it. No reservations, no idle bills, a signed receipt for every task.')),
    h(
      'div',
      { class: 'grid-2 reveal', 'data-delay': '1' },
      h('div', { class: 'card', style: { display: 'grid', gap: '14px' } }, floor, floorNote),
      h(
        'div',
        { class: 'card calc' },
        h('h3', null, 'Estimate a batch'),
        h('label', { class: 'field' }, h('span', null, 'Hardware class'), tier),
        h('label', { class: 'field' }, h('span', null, h('span', null, 'Tasks: '), tasksOut), tasks),
        h('label', { class: 'field' }, h('span', null, h('span', null, 'Output tokens per task: '), toksOut), toks),
        total,
        totalNote,
      ),
    ),
    h(
      'div',
      { class: 'card reveal', 'data-delay': '2', style: { marginTop: '24px' } },
      h('h3', { style: { marginBottom: '12px' } }, 'List rates'),
      h(
        'table',
        { class: 'table' },
        h('thead', null, h('tr', null, h('th', null, 'Hardware class'), h('th', null, 'Typical work'), h('th', null, 'Per 1k output tokens or units'))),
        h('tbody', null, RATES.map((r) => h('tr', null, h('td', null, r.label), h('td', null, r.examples), h('td', null, `$${r.per1k.toFixed(4)}`)))),
      ),
      h('p', { class: 'small muted', style: { marginTop: '12px' } }, `Volume: 10% off above $2,000 a month, 20% above $10,000. Reserved capacity (nodes held for you) is quoted per GPU-hour. Compute tasks are priced per thousand work units at the CPU rate. Node operators receive 80% of the task rate; the rest funds verification and the router. Operators cash out from $${PAYOUT_MIN_MICRO / 1e6}.`),
    ),
    h(
      'div',
      { class: 'grid-2 reveal', 'data-delay': '3', style: { marginTop: '24px' } },
      h(
        'div',
        { class: 'card', style: { display: 'grid', gap: '10px' } },
        h('h3', null, 'What you get'),
        h('ul', { style: { margin: 0, paddingLeft: '18px', color: 'var(--ink-2)', display: 'grid', gap: '6px' } },
          h('li', null, 'An OpenAI-compatible endpoint, so existing code works'),
          h('li', null, 'A signed receipt per task: which machine, which model, which input and output hashes, what it cost'),
          h('li', null, 'Spot-check verification on compute work; redundancy on request for model work'),
          h('li', null, 'Task text removed from the router ten minutes after completion'),
          h('li', null, 'Usage and spend by key, exportable'),
        ),
      ),
      h('div', { class: 'card' }, h('h3', { style: { marginBottom: '10px' } }, 'Talk to us'), qForm),
    ),
  );
  const stopReveal = mountReveals(el);
  return { el, title: 'Pricing', unmount: () => { unsub(); stopReveal(); } };
}
