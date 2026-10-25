// "Route one yourself": six made-up nodes, one job you shape with sliders,
// and the same ranking rules the router uses. Press the button and watch the
// candidates get eliminated one by one, the survivors sort by price, and the
// winner get stamped.

import type { NodeClass } from '@nightshift/shared';
import { h, prefersReducedMotion, fmtPerM, fmtUsd } from '../lib/dom';

interface SimNode {
  id: string;
  label: string;
  cls: NodeClass;
  models: string[];
  maxOut: number;
  maxPrompt: number;
  price: number;
  tps: number;
  busy: boolean;
}

const MODELS = ['qwen2.5-0.5b-instruct', 'smollm2-360m-instruct', 'llama-3.1-8b-instruct'];
const NAMES = ['firefox on mac', 'chrome on windows', 'edge on linux', 'safari on mac', 'ryzen box (cli)', 'mini pc (cli)', 'studio m2 (cli)', 'rented a10g', 'vendor api'];

let seed = 7;
function rnd(): number {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
function pick<T>(a: T[]): T {
  return a[Math.floor(rnd() * a.length)];
}

function makeNodes(): SimNode[] {
  const out: SimNode[] = [];
  const names = [...NAMES];
  for (let i = 0; i < 6; i++) {
    const label = names.splice(Math.floor(rnd() * names.length), 1)[0];
    const cls: NodeClass = label.includes('cli') ? 'native' : label.includes('rented') ? 'cloud' : label.includes('vendor') ? 'external' : 'browser';
    const models = cls === 'browser' ? [MODELS[0], ...(rnd() > 0.6 ? [MODELS[1]] : [])] : cls === 'native' ? [MODELS[0], MODELS[2]] : [MODELS[2]];
    out.push({
      id: 'n' + i,
      label,
      cls,
      models,
      maxOut: cls === 'browser' ? pick([128, 192, 256]) : pick([512, 1024, 2048]),
      maxPrompt: cls === 'browser' ? pick([4000, 6000]) : 16000,
      price: cls === 'browser' ? 200 + Math.floor(rnd() * 120) : cls === 'native' ? 350 + Math.floor(rnd() * 400) : 1500 + Math.floor(rnd() * 2500),
      tps: cls === 'browser' ? 6 + Math.floor(rnd() * 20) : 30 + Math.floor(rnd() * 90),
      busy: rnd() > 0.75,
    });
  }
  return out;
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
        h('span', null, n.models.map((m) => m.split('-')[0]).join(', ')),
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
    if (Number(tokens.value) > n.maxOut) return `caps output at ${n.maxOut}`;
    if (Number(prompt.value) > n.maxPrompt) return 'prompt too long for it';
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
    verdict.textContent = `${win.label} wins at ${fmtPerM(win.price)} tokens. The router holds ${fmtUsd(hold)} and sends the job there.`;
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
      h('div', { class: 'section-head reveal' }, h('h2', null, 'Route one yourself'), h('p', null, 'Six made-up nodes, the real rules. Change the job and see who gets it.')),
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
