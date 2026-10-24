// Earn: how to run a node, and a terminal view of what your key has earned.
//
// Two kinds of node can show up here. A GPU machine runs the agent from a
// terminal and keeps its key in ~/.docket; its owner can paste that key here
// to see its earnings, since the router only answers the key holder. A
// browser can also run a lightweight CPU node from this page, which is
// handy for trying the flow before installing anything.

import { NodeClient, runWorker, COMPUTE_ROUNDS_PER_UNIT, TIER_LABEL, PAYOUT_MIN_MICRO, type JobRecord, type Receipt, type Workload, type Signer } from '@docket/shared';
import { h, clear, fmtMs, mountReveals, timeHM, copyText, isPreview } from '../lib/dom';
import { API_BASE } from '../lib/api';
import { loadOrCreateNodeKey, importNodeKey } from '../lib/keys';
import { WorkerHost } from '../worker/host';
import { Field, LIGHT } from '../lib/field';
import { live } from '../lib/live';
import type { Page } from '../main';

const PREFS = 'docket.node.prefs';

interface Prefs {
  label: string;
  price: number;
}
function loadPrefs(): Prefs {
  const d: Prefs = { label: defaultLabel(), price: 250 };
  try {
    return { ...d, ...JSON.parse(localStorage.getItem(PREFS) ?? '{}') };
  } catch {
    return d;
  }
}
function savePrefs(p: Prefs): void {
  try {
    localStorage.setItem(PREFS, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}
function defaultLabel(): string {
  const a = ['quiet', 'brisk', 'plain', 'early', 'spare', 'steady', 'small', 'blue', 'grey', 'calm'];
  const b = ['lamp', 'kettle', 'harbour', 'ledger', 'pebble', 'maple', 'anvil', 'cedar', 'copper', 'quill'];
  const r = crypto.getRandomValues(new Uint16Array(3));
  return `${a[r[0] % a.length]}-${b[r[1] % b.length]}-${(r[2] % 900) + 100}`;
}
const usd = (micro: number) => `$${(micro / 1e6).toFixed(micro && micro < 10_000 ? 6 : 2)}`;
const hm = (ms: number) => `${Math.floor(ms / 3600000)}h ${String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0')}m`;

interface Me {
  node: { id: string; label: string; status: string; capabilities: { pricePer1k: number; hardware?: { gpu?: string; vramGb?: number; tier?: keyof typeof TIER_LABEL } }; jobsDone: number; jobsFailed: number; unitsVerified: number; earnedMicro: number };
  uptimeMs24h: number;
  payoutMinMicro: number;
  balanceMicro: number;
  jobs: JobRecord[];
  payouts: { id: string; amountMicro: number; rail: string; status: string; txRef?: string; createdAt: number }[];
}

export function earnPage(): Page {
  let key: Signer = loadOrCreateNodeKey();
  const prefs = loadPrefs();

  // --- the terminal ----------------------------------------------------------
  const term = h('pre', { class: 'term' }, 'Connecting…');
  const termNote = h('p', { class: 'small muted' }, 'Shows what the router knows about the key in this browser. Task content is never shown; you run the work, you do not see the customer’s data.');
  let client: NodeClient | null = null;
  let viewClient: NodeClient | null = null;
  let meTimer: number | undefined;

  function line(k: string, v: string): string {
    return k.padEnd(10) + v;
  }
  function renderMe(me: Me): void {
    const n = me.node;
    const hw = n.capabilities.hardware;
    const rows: string[] = [
      `docket · ${API_BASE || location.host}`,
      '',
      line('node', `${n.label}  ${n.id}`),
      line('status', n.status),
      line('hardware', `${hw?.gpu ?? 'not reported'}${hw?.vramGb ? `, ${hw.vramGb} GB` : ''}${hw?.tier ? `  (${TIER_LABEL[hw.tier]})` : ''}`),
      line('price', `${n.capabilities.pricePer1k} µcr per 1k units`),
      line('uptime', `${hm(me.uptimeMs24h)} today`),
      '',
      line('balance', `${usd(me.balanceMicro)}  spendable or payable`),
      line('lifetime', `${usd(n.earnedMicro)} across ${n.jobsDone} task${n.jobsDone === 1 ? '' : 's'}, ${n.unitsVerified} units verified, ${n.jobsFailed} failed`),
      line('payout', me.balanceMicro >= me.payoutMinMicro ? `eligible (minimum ${usd(me.payoutMinMicro)})` : `${usd(me.payoutMinMicro - me.balanceMicro)} to go before SOL/USDC payout`),
    ];
    if (me.payouts.length) {
      rows.push('', 'payouts');
      for (const p of me.payouts.slice(0, 5)) rows.push(`  ${timeHM(p.createdAt)}  ${usd(p.amountMicro).padStart(10)}  ${p.rail.padEnd(7)} ${p.status}${p.txRef ? '  ' + p.txRef : ''}`);
    }
    rows.push('', 'recent tasks');
    if (!me.jobs.length) rows.push('  none yet');
    for (const j of me.jobs.slice(0, 10)) {
      rows.push(`  ${timeHM(j.createdAt)}  ${j.input.workload.padEnd(8)} ${j.status.padEnd(9)} ${(j.output?.durationMs ? fmtMs(j.output.durationMs) : '').padStart(7)}  ${(j.costMicro ? usd(j.costMicro) : '').padStart(10)}`);
    }
    term.textContent = rows.join('\n');
    payBtn.disabled = me.balanceMicro < (payRail.value === 'credits' ? 1 : me.payoutMinMicro);
  }
  async function refreshMe(): Promise<void> {
    const c = client ?? viewClient;
    if (!c?.node) return;
    try {
      renderMe((await c.me()) as Me);
    } catch (err) {
      term.textContent = `router unreachable: ${(err as Error).message}`;
    }
  }

  /** Look the key up without changing anything about the node. */
  async function lookup(): Promise<void> {
    viewClient = new NodeClient({ baseUrl: API_BASE, signer: key, class: 'native', label: '', capabilities: { workloads: ['compute'], models: [], maxPromptChars: 1, maxOutputTokens: 16, pricePer1k: 200 }, lookupOnly: true });
    try {
      await viewClient.register();
      await refreshMe();
    } catch {
      viewClient = null;
      term.textContent = 'No node has registered with this key yet.\n\nRun the agent on a GPU machine (install command on the left), or start a lightweight node in this tab, and this view fills in.';
    }
  }

  // --- import a key from a GPU machine -----------------------------------------
  const importField = h('input', { class: 'input mono', placeholder: 'paste the contents of ~/.docket/worker.key' }) as HTMLInputElement;
  const importBtn = h('button', { class: 'btn sm secondary' }, 'View this key') as HTMLButtonElement;
  importBtn.addEventListener('click', async () => {
    const k = importNodeKey(importField.value.trim());
    if (!k) {
      termNote.textContent = 'That is not a valid key. It is one line of base64 in ~/.docket/worker.key on the machine running the agent.';
      return;
    }
    key = k;
    importField.value = '';
    termNote.textContent = 'Viewing the imported key. It is kept only in this browser.';
    await lookup();
  });

  // --- lightweight browser node ---------------------------------------------
  const label = h('input', { class: 'input', value: prefs.label, maxlength: 48 }) as HTMLInputElement;
  const price = h('input', { class: 'input', type: 'number', min: 200, max: 100000, step: 10, value: prefs.price }) as HTMLInputElement;
  const startBtn = h('button', { class: 'btn stamp' }, 'Start a node in this tab') as HTMLButtonElement;
  const stopBtn = h('button', { class: 'btn secondary', disabled: true }, 'Stop') as HTMLButtonElement;
  const statusEl = h('div', { class: 'status' }, h('i'), h('span', null, 'Not running'));
  const setStatus = (cls: string, text: string) => {
    statusEl.className = `status ${cls}`;
    statusEl.lastElementChild!.textContent = text;
  };
  let host: WorkerHost | null = null;
  let abort: AbortController | null = null;
  const shouldWork = () => document.visibilityState === 'visible';

  async function start(): Promise<void> {
    const p: Prefs = { label: label.value.trim() || defaultLabel(), price: Number(price.value) || 250 };
    savePrefs(p);
    startBtn.disabled = true;
    host = new WorkerHost();
    const workloads: Workload[] = ['compute'];
    client = new NodeClient({ baseUrl: API_BASE, signer: key, class: 'browser', label: p.label, capabilities: { workloads, models: [], maxPromptChars: 6000, maxOutputTokens: 128, pricePer1k: p.price, tokensPerSec: 6, hardware: { tier: 'cpu' } } });
    abort = new AbortController();
    stopBtn.disabled = false;
    const work = async (job: JobRecord) => {
      const out = await host!.compute(job.input.seed ?? 0, job.input.rounds ?? 0);
      out.units = Math.ceil((job.input.rounds ?? 0) / COMPUTE_ROUNDS_PER_UNIT);
      return out;
    };
    runWorker(
      client,
      work,
      {
        status: (s) => {
          if (s === 'registering') setStatus('registering', 'Registering');
          if (s === 'idle') setStatus('idle', shouldWork() ? 'Online, waiting for work' : 'Paused while hidden');
          if (s === 'working') setStatus('working', 'Working');
          if (s === 'error') setStatus('error', 'Connection trouble, retrying');
          if (s === 'offline') setStatus('', 'Not running');
        },
        done: (_j: JobRecord, _r: Receipt) => void refreshMe(),
      },
      { shouldWork, signal: abort.signal },
    ).catch((err) => setStatus('error', (err as Error).message));
    setTimeout(() => void refreshMe(), 1500);
  }
  function stop(): void {
    abort?.abort();
    abort = null;
    host?.terminate();
    host = null;
    client = null;
    stopBtn.disabled = true;
    startBtn.disabled = false;
    setStatus('', 'Not running');
  }
  startBtn.addEventListener('click', () => void start());
  stopBtn.addEventListener('click', stop);

  // --- payout ---------------------------------------------------------------
  const payAmount = h('input', { class: 'input', type: 'number', min: 50, step: 1, placeholder: '50' }) as HTMLInputElement;
  const payRail = h('select', { class: 'select' }, h('option', { value: 'usdc' }, 'USDC on Solana'), h('option', { value: 'sol' }, 'SOL'), h('option', { value: 'credits' }, 'Keep as credits')) as HTMLSelectElement;
  const payAddr = h('input', { class: 'input mono', placeholder: 'Solana wallet address' }) as HTMLInputElement;
  const payBtn = h('button', { class: 'btn secondary', disabled: true }, 'Request payout') as HTMLButtonElement;
  const payNote = h('p', { class: 'small muted' }, `Payouts open at ${usd(PAYOUT_MIN_MICRO)} earned. SOL and USDC requests are settled by the operator; you will see the transaction reference here once it goes out.`);
  payRail.addEventListener('change', () => {
    payAddr.style.display = payRail.value === 'credits' ? 'none' : '';
    void refreshMe();
  });
  payBtn.addEventListener('click', async () => {
    const c = client ?? viewClient;
    if (!c) return;
    const amount = Math.round(Number(payAmount.value) * 1_000_000);
    payBtn.disabled = true;
    try {
      const p = (await c.requestPayout(amount, payRail.value as 'credits' | 'usdc' | 'sol', payAddr.value.trim() || undefined)) as { status: string; id: string };
      payNote.textContent = p.status === 'sent' ? 'Done. Credits stay in your balance.' : `Recorded as ${p.status} (${p.id}). The operator settles these; the reference will appear here when it is sent.`;
      void refreshMe();
    } catch (err) {
      payNote.textContent = (err as Error).message;
    } finally {
      payBtn.disabled = false;
    }
  });

  // --- live map of this node's neighbourhood -------------------------------------
  const miniCanvas = h('canvas', { class: 'mini-field tall', 'aria-hidden': 'true' });
  const mini = new Field(miniCanvas, LIGHT, { ghosts: 0, labels: true, interactive: true, routerLabel: 'router' });
  const unsubLive = live.subscribe((ev) => mini.apply(ev));

  const install = `git clone <repo> docket && cd docket && npm install\nDOCKET_URL=${API_BASE || location.origin} npm run worker`;
  const pub = h('code', { class: 'small', style: { wordBreak: 'break-all' } }, key.publicKey);

  const el = h(
    'div',
    { class: 'container section' },
    h('div', { class: 'section-head reveal' }, h('h1', null, 'Earn with your hardware'), h('p', null, 'Run the agent on a machine with a GPU and it takes tasks from businesses using the network. You are paid per task, by hardware class, and can cash out in SOL or USDC once you reach $50.')),
    h(
      'div',
      { class: 'worker reveal', 'data-delay': '1' },
      h(
        'div',
        { style: { display: 'grid', gap: '16px' } },
        h(
          'div',
          { class: 'card', style: { display: 'grid', gap: '12px' } },
          h('h3', null, 'Run the agent on a GPU machine'),
          h('p', { class: 'small muted' }, 'One process. It detects your GPU, picks a price for its class, and starts taking work. Your key is written to ~/.docket/worker.key; back it up, it is your earnings account.'),
          h('pre', null, h('code', null, isPreview() ? 'git clone <repo> docket && cd docket && npm install\nDOCKET_URL=https://your-router npm run worker' : install)),
          h('p', { class: 'small muted' }, 'To serve language-model tasks, point DOCKET_LLM_URL at a local llama.cpp, Ollama or vLLM server and list the models in DOCKET_MODELS. Compute tasks need nothing extra.'),
          h('div', { class: 'row' }, h('a', { class: 'btn sm secondary', href: '/docs/earning' }, 'How earnings work'), h('a', { class: 'btn sm secondary', href: '/docs/run-a-node' }, 'Agent reference')),
        ),
        h(
          'div',
          { class: 'card', style: { display: 'grid', gap: '12px' } },
          h('h3', null, 'Or try a lightweight node in this tab'),
          h('p', { class: 'small muted' }, 'CPU only, compute tasks only, pauses when the tab is hidden. Useful to see the flow before you install anything.'),
          statusEl,
          miniCanvas,
          h('div', { class: 'grid-2', style: { gap: '12px' } }, h('label', { class: 'field' }, h('span', null, 'Node name on the map'), label), h('label', { class: 'field' }, h('span', null, 'Price, µcr per 1k units'), price)),
          h('div', { class: 'row' }, startBtn, stopBtn),
        ),
      ),
      h(
        'div',
        { style: { display: 'grid', gap: '16px' } },
        h('div', { class: 'card flush term-card' }, h('div', { class: 'term-bar' }, h('span'), h('span'), h('span'), h('b', null, 'docket earnings')), term, h('div', { style: { padding: '0 16px 16px' } }, termNote)),
        h(
          'div',
          { class: 'card', style: { display: 'grid', gap: '12px' } },
          h('h3', null, 'View a GPU node from here'),
          h('p', { class: 'small muted' }, 'The terminal above shows this browser’s key. To see a machine running the agent, paste its key. Or run `npm run cli watch` on that machine instead.'),
          h('div', { class: 'row' }, importField, importBtn),
          h('p', { class: 'small muted' }, 'This browser’s key: '),
          pub,
          h('div', { class: 'row' }, h('button', { class: 'btn sm secondary', onClick: () => copyText(key.publicKey) }, 'Copy public key')),
        ),
        h(
          'div',
          { class: 'card', style: { display: 'grid', gap: '12px' } },
          h('h3', null, 'Payout'),
          h('div', { class: 'grid-2', style: { gap: '12px' } }, h('label', { class: 'field' }, h('span', null, 'Amount, USD'), payAmount), h('label', { class: 'field' }, h('span', null, 'Rail'), payRail)),
          payAddr,
          h('div', { class: 'row' }, payBtn),
          payNote,
        ),
      ),
    ),
  );
  const stopReveal = mountReveals(el);
  void lookup();
  meTimer = window.setInterval(() => void refreshMe(), 10_000);

  return {
    el,
    title: 'Earn',
    unmount() {
      stop();
      clearInterval(meTimer);
      unsubLive();
      mini.destroy();
      stopReveal();
    },
  };
}
