// "Route one yourself": nine made-up nodes, one job you shape with sliders,
// and the same ranking rules the router uses. Press the button and watch the
// candidates get eliminated one by one, the survivors sort by price, and the
// winner get stamped.

import type { NodeClass } from '@nightshift/shared';
import { h, prefersReducedMotion, fmtPerM, fmtUsd } from '../lib/dom';

interface SimNode {
  id: string;
  label: string;
  cls: NodeClass;
  gpu: string;
  models: string[];
  maxOut: number;
  maxPrompt: number;
  price: number;
  tps: number;
  busy: boolean;
}

const MODELS = ['qwen2.5-0.5b-instruct', 'smollm2-360m-instruct', 'qwen2.5-7b-instruct', 'llama-3.1-8b-instruct'];
const [Q05, SMOL, Q7, L8] = MODELS;

let seed = 7;
function rnd(): number {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}

/**
 * A spread of machines, small to big, so every slider position has takers
 * and the gaps between them are the kind you'd actually see: a laptop tab, a
 * mid-range desktop, a 24 GB card, a rented one, a paid API.
 * The biggest native boxes cover every model at the sliders' maximums, so
 * the demo never dead-ends unless you make it (model nobody small serves +
 * the big ones busy).
 */
const FLEET: Omit<SimNode, 'id' | 'busy'>[] = [
  { label: 'firefox on mac', cls: 'browser', gpu: 'Apple M1 · 8 GB', models: [Q05, SMOL], maxOut: 192, maxPrompt: 6000, price: 320, tps: 17 },
  { label: 'chrome on windows', cls: 'browser', gpu: 'RTX 3060 · 12 GB', models: [Q05, SMOL], maxOut: 256, maxPrompt: 8000, price: 360, tps: 24 },
  { label: 'edge on linux', cls: 'browser', gpu: 'RTX 4070 · 12 GB', models: [Q05, SMOL, L8], maxOut: 512, maxPrompt: 12000, price: 450, tps: 31 },
  { label: 'mini pc (cli)', cls: 'native', gpu: 'RTX 4060 · 8 GB', models: [Q05, SMOL], maxOut: 768, maxPrompt: 16000, price: 400, tps: 60 },
  { label: 'ryzen box (cli)', cls: 'native', gpu: 'RTX 3080 · 10 GB', models: [Q05, SMOL, L8], maxOut: 1024, maxPrompt: 16000, price: 560, tps: 75 },
  { label: 'studio m2 (cli)', cls: 'native', gpu: 'M2 Max · 32 GB', models: [Q05, SMOL, Q7, L8], maxOut: 1024, maxPrompt: 16000, price: 700, tps: 65 },
  { label: '4090 rig (cli)', cls: 'native', gpu: 'RTX 4090 · 24 GB', models: [Q05, SMOL, Q7, L8], maxOut: 2048, maxPrompt: 16000, price: 820, tps: 140 },
  { label: 'rented a10g', cls: 'cloud', gpu: 'A10G · 24 GB', models: [Q7, L8], maxOut: 2048, maxPrompt: 16000, price: 1600, tps: 96 },
  { label: 'vendor api', cls: 'external', gpu: 'hosted', models: [L8], maxOut: 2048, maxPrompt: 16000, price: 2800, tps: 53 },
];

function makeNodes(): SimNode[] {
  // Same machines every time; what changes is who's busy and the exact asking
  // price, which is what changes on a real network minute to minute.
  const nodes = FLEET.map((f, i) => ({ ...f, id: 'n' + i, busy: false, price: Math.round(f.price * (0.9 + rnd() * 0.2)) }));
  const busyCount = 2 + Math.floor(rnd() * 2);
  const idx = nodes.map((_, i) => i).sort(() => rnd() - 0.5).slice(0, busyCount);
  for (const i of idx) nodes[i].busy = true;
  // keep at least one of the two all-rounders free so a maxed-out job has a taker
  const all = nodes.filter((n) => n.models.length === MODELS.length);
  if (all.every((n) => n.busy)) all[Math.floor(rnd() * all.length)].busy = false;
  return nodes;
}

function shortModel(m: string): string {
  return m.replace('-instruct', '').replace('qwen2.5-', 'qwen ').replace('llama-3.1-', 'llama ').replace('smollm2-', 'smollm ');
}

export function simulatorSection(): HTMLElement {
  let nodes = makeNodes();
  const board = h('div', { class: 'sim-board' });
  const model = h('select', { class: 'select' }, MODELS.map((m) => h('option', { value: m }, m))) as HTMLSelectElement;
  const tokens = h('input', { type: 'range', min: 32, max: 1024, step: 32, value: 160 }) as HTMLInputElement;
  const prompt = h('input', { type: 'range', min: 200, max: 12000, step: 200, value: 1200 }) as HTMLInputElement;
  const tokensOut = h('span', null, '160');
  const promptOut = h('span', null, '1,200');
  const route = h('button', { class: 'btn stamp' }, 'Route it') as HTMLButtonElement;
  const shuffle = h('button', { class: 'btn secondary' }, 'New nodes') as HTMLButtonElement;
  const verdict = h('p', { class: 'sim-verdict' }, 'Shape the job, then press Route it.');

  const cardOf = new Map<string, HTMLElement>();

  function card(n: SimNode): HTMLElement {
    const el = h(
      'div',
      { class: `sim-card ${n.cls}`, 'data-id': n.id },
      h('div', { class: 'sim-top' }, h('b', null, n.label), h('span', { class: 'tag' }, n.cls)),
      h('div', { class: 'sim-price' }, `$${(n.price / 1000).toFixed(2)}`, h('small', null, ' per 1M tokens')),
      h(
        'div',
        { class: 'sim-meta' },
        h('span', { class: 'sim-gpu' }, n.gpu),
        h('span', null, n.models.map(shortModel).join(', ')),
        h('span', null, `≤ ${n.maxOut} out · ≤ ${(n.maxPrompt / 1000).toFixed(0)}k chars`),
        h('span', null, `${n.tps} tok/s`),
        h('span', { class: `sim-state ${n.busy ? 'busy' : ''}` }, n.busy ? 'busy' : 'idle'),
      ),
      h('div', { class: 'sim-why' }),
      h('span', { class: 'stamped' }, 'ROUTED'),
    );
    cardOf.set(n.id, el);
    return el;
  }

  function render(): void {
    board.replaceChildren(...nodes.map(card));
    verdict.textContent = 'Shape the job, then press Route it.';
  }

  function reason(n: SimNode): string | null {
    if (n.busy) return 'busy right now';
    if (!n.models.includes(model.value)) return "doesn't serve this model";
    if (Number(tokens.value) > n.maxOut) return `caps output at ${n.maxOut} tokens`;
    if (Number(prompt.value) > n.maxPrompt) return `takes prompts up to ${(n.maxPrompt / 1000).toFixed(0)}k chars`;
    return null;
  }

  async function run(): Promise<void> {
    route.disabled = true;
    shuffle.disabled = true;
    const fast = prefersReducedMotion();
    const wait = (ms: number) => new Promise((r) => setTimeout(r, fast ? 0 : ms));
    for (const el of cardOf.values()) {
      el.classList.remove('out', 'win', 'checking');
      el.querySelector('.sim-why')!.textContent = '';
    }
    verdict.textContent = 'Checking who can take it…';
    const survivors: SimNode[] = [];
    for (const n of nodes) {
      const el = cardOf.get(n.id)!;
      el.classList.add('checking');
      await wait(260);
      const why = reason(n);
      el.classList.remove('checking');
      if (why) {
        el.classList.add('out');
        el.querySelector('.sim-why')!.textContent = why;
      } else survivors.push(n);
    }
    if (survivors.length === 0) {
      verdict.textContent = 'Nothing can take that job. It would sit in the queue at the floor price until a node that fits comes online.';
      route.disabled = false;
      shuffle.disabled = false;
      return;
    }
    await wait(300);
    verdict.textContent = `${survivors.length} can. Sorting by price, then by claimed speed…`;
    // FLIP: record, reorder DOM, invert, play
    const first = new Map<string, DOMRect>();
    for (const [id, el] of cardOf) first.set(id, el.getBoundingClientRect());
    const sorted = [...survivors].sort((a, b) => a.price - b.price || b.tps - a.tps);
    const order = [...sorted, ...nodes.filter((n) => !survivors.includes(n))];
    board.replaceChildren(...order.map((n) => cardOf.get(n.id)!));
    for (const [id, el] of cardOf) {
      const a = first.get(id)!;
      const b = el.getBoundingClientRect();
      const dx = a.left - b.left;
      const dy = a.top - b.top;
      if (!fast && (dx || dy)) {
        el.style.transform = `translate(${dx}px, ${dy}px)`;
        el.style.transition = 'none';
        void el.offsetWidth;
        el.style.transition = 'transform 520ms cubic-bezier(.2,.7,.2,1)';
        el.style.transform = '';
      }
    }
    await wait(620);
    const win = sorted[0];
    cardOf.get(win.id)!.classList.add('win');
    const hold = Math.ceil((Number(tokens.value) * win.price) / 1000);
    const runnerUp = sorted[1];
    verdict.textContent = `${win.label} (${win.gpu}) wins at ${fmtPerM(win.price)} tokens. The router holds ${fmtUsd(hold)} and sends the job there.` + (runnerUp ? ` ${runnerUp.label} was next at ${fmtPerM(runnerUp.price)}.` : ' It was the only one that fit.');
    route.disabled = false;
    shuffle.disabled = false;
  }

  tokens.addEventListener('input', () => (tokensOut.textContent = tokens.value));
  prompt.addEventListener('input', () => (promptOut.textContent = Number(prompt.value).toLocaleString()));
  route.addEventListener('click', () => void run());
  shuffle.addEventListener('click', () => {
    nodes = makeNodes();
    render();
  });
  render();

  return h(
    'section',
    { class: 'section sim' },
    h(
      'div',
      { class: 'container' },
      h('div', { class: 'section-head reveal' }, h('h2', null, 'Route one yourself'), h('p', null, 'Nine made-up machines, from a laptop tab to a rented card, and the real rules. Change the job and see who gets it: the cheapest machine that fits wins, not the biggest.')),
      h(
        'div',
        { class: 'sim-grid reveal', 'data-delay': '1' },
        h(
          'div',
          { class: 'card sim-controls' },
          h('label', { class: 'field' }, h('span', null, 'Model'), model),
          h('label', { class: 'field' }, h('span', null, h('span', null, 'Max output tokens: '), tokensOut), tokens),
          h('label', { class: 'field' }, h('span', null, h('span', null, 'Prompt length, characters: '), promptOut), prompt),
          h('div', { class: 'row' }, route, shuffle),
          verdict,
        ),
        board,
      ),
    ),
  );
}
