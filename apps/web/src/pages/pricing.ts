// Business pricing. Led by GPU-hours, because that's where a swarm of
// consumer cards beats a datacenter. Per-token rates are offered for small
// open models and sit close to the hosted market, where the real competition
// is. The live floor at the top is what the network quotes right now.

import { HOURLY_SUGGESTED, PER_1K_SUGGESTED, withFee, type HardwareTier } from '@nightshift/shared';
import type { LiveEvent } from '@nightshift/shared';
import { h, mountReveals } from '../lib/dom';
import { live } from '../lib/live';
import { api } from '../lib/api';
import type { Page } from '../main';

// List rates, USD: the node's suggested rate plus the platform fee, straight
// from the shared constants so this page can't drift from what the router
// charges. Node operators receive 80% of these.
const usdH = (t: HardwareTier) => withFee(HOURLY_SUGGESTED[t]) / 1e6;
const usdM = (t: HardwareTier) => withFee(PER_1K_SUGGESTED[t]) / 1000;
export const RATES: { tier: HardwareTier; label: string; perHour: number; perMTok: number | null; examples: string }[] = [
  { tier: 'cpu', label: 'CPU nodes', perHour: usdH('cpu'), perMTok: null, examples: 'compute tasks, data prep' },
  { tier: 'gpu-8', label: 'GPU up to 8 GB', perHour: usdH('gpu-8'), perMTok: usdM('gpu-8'), examples: '1–3B models, embeddings, small image models' },
  { tier: 'gpu-16', label: 'GPU 12–16 GB', perHour: usdH('gpu-16'), perMTok: usdM('gpu-16'), examples: '7–8B models, Stable Diffusion, fine-tuning small models' },
  { tier: 'gpu-24', label: 'GPU 20–24 GB', perHour: usdH('gpu-24'), perMTok: usdM('gpu-24'), examples: '13B models, quantised 30B, video and image pipelines' },
  { tier: 'gpu-48', label: 'GPU 32–48 GB', perHour: usdH('gpu-48'), perMTok: usdM('gpu-48'), examples: '30–34B models, LoRA fine-tuning' },
  { tier: 'gpu-80', label: 'GPU 80 GB+', perHour: usdH('gpu-80'), perMTok: usdM('gpu-80'), examples: '70B models, long contexts, full fine-tunes' },
];

export function pricingPage(): Page {
  const floor = h('div', { class: 'price-big' }, '—', h('small', null, 'nodes online right now'));
  const floorNote = h('p', { class: 'muted' }, 'Live count from this router. Capacity is whatever is online; reserved capacity is quoted.');
  const unsub = live.subscribe((ev: LiveEvent) => {
    if (ev.t === 'hello' || ev.t === 'stats') {
      floor.firstChild!.textContent = String(ev.stats.nodesOnline);
      floorNote.textContent = `${ev.stats.nodesRegistered} node${ev.stats.nodesRegistered === 1 ? '' : 's'} registered, ${ev.stats.nodesOnline} online now. Capacity is what is online; reserved capacity is quoted.`;
    }
  });

  // --- estimator: GPU-hours ---
  const tier = h('select', { class: 'select', id: 'p-tier' }, RATES.map((r) => h('option', { value: r.tier }, r.label))) as HTMLSelectElement;
  tier.value = 'gpu-16';
  const cards = h('input', { type: 'range', min: 1, max: 500, step: 1, value: 40, id: 'p-cards' }) as HTMLInputElement;
  const hours = h('input', { type: 'range', min: 1, max: 720, step: 1, value: 24, id: 'p-hours' }) as HTMLInputElement;
  const cardsOut = h('span', null, '40');
  const hoursOut = h('span', null, '24');
  const total = h('output', null, '—');
  const totalNote = h('p', { class: 'small muted' });
  const compare = h('p', { class: 'small muted' });
  function recompute(): void {
    const r = RATES.find((x) => x.tier === tier.value)!;
    const n = Number(cards.value);
    const hr = Number(hours.value);
    cardsOut.textContent = String(n);
    hoursOut.textContent = String(hr);
    const usd = n * hr * r.perHour;
    total.textContent = `$${usd.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
    totalNote.textContent = `${n} ${r.label.toLowerCase()} card${n === 1 ? '' : 's'} for ${hr} hour${hr === 1 ? '' : 's'} at $${r.perHour.toFixed(2)} per card-hour. Billed by the second each card actually worked.`;
    const cloud = r.tier === 'gpu-80' ? 3.0 : r.tier === 'gpu-48' ? 2.0 : r.tier === 'gpu-24' ? 1.1 : r.tier === 'gpu-16' ? 0.7 : 0.5;
    compare.textContent = r.tier === 'cpu' ? '' : `Roughly $${(n * hr * cloud).toLocaleString(undefined, { maximumFractionDigits: 0 })} for the same card-hours from a major cloud at on-demand rates. Check their current prices; ours are listed here.`;
  }
  [tier, cards, hours].forEach((c) => c.addEventListener('input', recompute));
  recompute();

  // --- quote form ---
  const qName = h('input', { class: 'input', placeholder: 'Company', id: 'q-company' }) as HTMLInputElement;
  const qEmail = h('input', { class: 'input', type: 'email', placeholder: 'Work email', id: 'q-email' }) as HTMLInputElement;
  const qNeed = h('textarea', { class: 'textarea', rows: 3, placeholder: 'What are you running? Workload, model, card count, how long, deadline.', id: 'q-need' }) as HTMLTextAreaElement;
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

  const catalogue: [string, string, string][] = [
    ['Batch inference', 'Open models on your rows: classification, extraction, summarisation, synthetic data. OpenAI-compatible endpoint.', 'available'],
    ['Embeddings', 'Whole corpora through an embedding model, returned as vectors with a receipt per batch.', 'on request'],
    ['Image and video generation', 'Stable Diffusion family and similar, one card per job, billed by the second.', 'on request'],
    ['Fine-tuning', 'LoRA and small full fine-tunes on 24 GB+ cards. Your data, your weights back.', 'on request'],
    ['Your own model', 'Bring weights in a supported format; the agent serves them on cards that fit. Billed by card-hour.', 'on request'],
  ];

  const el = h(
    'div',
    { class: 'container section' },
    h('div', { class: 'section-head reveal' }, h('h1', null, 'Pricing for businesses'), h('p', null, 'Rent a swarm of consumer GPUs by the card-hour, billed by the second each card works, with a signed receipt per task. Small open models are also available per token.')),
    h(
      'div',
      { class: 'grid-2 reveal', 'data-delay': '1' },
      h('div', { class: 'card', style: { display: 'grid', gap: '14px' } }, floor, floorNote),
      h(
        'div',
        { class: 'card calc' },
        h('h3', null, 'Estimate a run'),
        h('label', { class: 'field' }, h('span', null, 'Hardware class'), tier),
        h('label', { class: 'field' }, h('span', null, h('span', null, 'Cards: '), cardsOut), cards),
        h('label', { class: 'field' }, h('span', null, h('span', null, 'Hours each: '), hoursOut), hours),
        total,
        totalNote,
        compare,
      ),
    ),
    h(
      'div',
      { class: 'card reveal', 'data-delay': '2', style: { marginTop: '24px' } },
      h('h3', { style: { marginBottom: '12px' } }, 'List rates'),
      h(
        'table',
        { class: 'table' },
        h('thead', null, h('tr', null, h('th', null, 'Hardware class'), h('th', null, 'Typical work'), h('th', { style: { textAlign: 'right' } }, 'Per card-hour'), h('th', null, 'Per 1M output tokens'))),
        h('tbody', null, RATES.map((r) => h('tr', null, h('td', null, r.label), h('td', null, r.examples), h('td', { style: { textAlign: 'right' } }, `$${r.perHour.toFixed(2)}`), h('td', null, r.perMTok === null ? '—' : `$${r.perMTok.toFixed(2)}`)))),
      ),
      h('p', { class: 'small muted', style: { marginTop: '12px' } }, `Card-hour billing counts the seconds a card held your job, measured by the router. Per-token billing counts output tokens returned. Volume: 10% off above $2,000 a month, 20% above $10,000. Reserved capacity (cards held for you) is quoted. Node operators receive 80% of these rates and cash out in USDC on Solana.`),
    ),
    h(
      'div',
      { class: 'card reveal', 'data-delay': '2', style: { marginTop: '24px' } },
      h('h3', { style: { marginBottom: '4px' } }, 'What runs on the network'),
      h('p', { class: 'small muted', style: { marginBottom: '12px' } }, 'A fixed catalogue, not arbitrary code. That is what keeps node owners’ machines safe and lets the router verify results.'),
      h('div', { class: 'cat' }, catalogue.map(([name, blurb, status]) => h('div', { class: 'cat-row' }, h('b', null, name), h('span', null, blurb), h('span', { class: `tag ${status === 'available' ? 'ok' : ''}` }, status)))),
    ),
    h(
      'div',
      { class: 'grid-2 reveal', 'data-delay': '3', style: { marginTop: '24px' } },
      h(
        'div',
        { class: 'card', style: { display: 'grid', gap: '10px' } },
        h('h3', null, 'When this is the right tool'),
        h('ul', { style: { margin: 0, paddingLeft: '18px', color: 'var(--ink-2)', display: 'grid', gap: '6px' } },
          h('li', null, 'Work that needs whole cards for hours: generation, fine-tuning, embeddings over large corpora, your own model'),
          h('li', null, 'Batches where a signed receipt per task matters: audits, reproducibility, chargeback'),
          h('li', null, 'Price-sensitive workloads that can tolerate nodes coming and going; the router retries and re-routes'),
        ),
        h('h3', { style: { marginTop: '8px' } }, 'When it is not'),
        h('ul', { style: { margin: 0, paddingLeft: '18px', color: 'var(--ink-2)', display: 'grid', gap: '6px' } },
          h('li', null, 'Latency-sensitive chat: use a hosted API'),
          h('li', null, 'Commodity small-model tokens at the lowest possible price: hosted APIs are close to or below our per-token rates'),
          h('li', null, 'Data that must never touch a machine you don’t control: see the Privacy doc'),
        ),
      ),
      h('div', { class: 'card' }, h('h3', { style: { marginBottom: '10px' } }, 'Talk to us'), qForm),
    ),
  );
  const stopReveal = mountReveals(el);
  return { el, title: 'Pricing', unmount: () => { unsub(); stopReveal(); } };
}
