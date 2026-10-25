// Earn: how to run a node, and a terminal view of what your key has earned.
//
// Two kinds of node can show up here. A GPU machine runs the agent from a
// terminal and keeps its key in ~/.nightshift; its owner can paste that key here
// to see its earnings, since the router only answers the key holder. A
// browser can also run a lightweight CPU node from this page, which is
// handy for trying the flow before installing anything.

import { NodeClient, TIER_LABEL, PAYOUT_MIN_MICRO, type JobRecord, type Signer } from '@nightshift/shared';
import { nodeRuntime, type NodeSettings } from '../lib/noderuntime';
import { h, clear, fmtMs, mountReveals, timeHM, copyText, isPreview, fmtPerM } from '../lib/dom';
import { API_BASE } from '../lib/api';
import { loadOrCreateNodeKey, importNodeKey } from '../lib/keys';
import type { Page } from '../main';

const PREFS = 'nightshift.node.prefs';

type Prefs = NodeSettings;
function loadPrefs(): Prefs {
  const d: Prefs = { label: defaultLabel(), price: 250, serveModel: true, background: true, maxOut: 192 };
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
  node: { id: string; label: string; status: string; capabilities: { pricePer1k: number; pricePerHour?: number; hardware?: { gpu?: string; vramGb?: number; tier?: keyof typeof TIER_LABEL } }; jobsDone: number; jobsFailed: number; unitsVerified: number; earnedMicro: number };
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
  let viewClient: NodeClient | null = null;
  let meTimer: number | undefined;

  function line(k: string, v: string): string {
    return k.padEnd(10) + v;
  }
  function renderMe(me: Me): void {
    const n = me.node;
    const hw = n.capabilities.hardware;
    const rows: string[] = [
      `nightshift · ${API_BASE || location.host}`,
      '',
      line('node', `${n.label}  ${n.id}`),
      line('status', n.status),
      line('hardware', `${hw?.gpu ?? 'not reported'}${hw?.vramGb ? `, ${hw.vramGb} GB` : ''}${hw?.tier ? `  (${TIER_LABEL[hw.tier]})` : ''}`),
      line('price', `$${((n.capabilities.pricePerHour ?? 0) / 1e6).toFixed(2)} per hour · ${fmtPerM(n.capabilities.pricePer1k)} tokens`),
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
    const c = client() ?? viewClient;
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
  const importField = h('input', { class: 'input mono', placeholder: 'paste the contents of ~/.nightshift/worker.key' }) as HTMLInputElement;
  const importBtn = h('button', { class: 'btn sm secondary' }, 'View this key') as HTMLButtonElement;
  importBtn.addEventListener('click', async () => {
    const k = importNodeKey(importField.value.trim());
    if (!k) {
      termNote.textContent = 'That is not a valid key. It is one line of base64 in ~/.nightshift/worker.key on the machine running the agent.';
      return;
    }
    key = k;
    importField.value = '';
    termNote.textContent = 'Viewing the imported key. It is kept only in this browser.';
    await lookup();
  });

  // --- the node in this tab ----------------------------------------------------
  const label = h('input', { class: 'input', value: prefs.label, maxlength: 48, id: 'n-label' }) as HTMLInputElement;
  const price = h('input', { class: 'input', type: 'number', min: 0.2, max: 100, step: 0.05, value: (prefs.price / 1000).toFixed(2), id: 'n-price' }) as HTMLInputElement;
  const serveModel = h('input', { type: 'checkbox', checked: prefs.serveModel, id: 'n-model' }) as HTMLInputElement;
  const background = h('input', { type: 'checkbox', checked: prefs.background, id: 'n-bg' }) as HTMLInputElement;
  const modelLabel = h('span', null, 'Serve model tasks on this GPU (WebGPU)');
  const startBtn = h('button', { class: 'btn stamp' }, 'Start earning') as HTMLButtonElement;
  const stopBtn = h('button', { class: 'btn secondary', disabled: true }, 'Stop') as HTMLButtonElement;
  const statusEl = h('div', { class: 'status' }, h('i'), h('span', null, 'Not running'));
  const statusNote = h('p', { class: 'small muted' }, 'Nothing to install. Press start and this tab registers as a node and takes work while it is open.');
  const progress = h('div', { class: 'bar', hidden: true }, h('i'));
  const gpuLine = h('p', { class: 'small muted' }, 'Checking for a GPU…');

  void nodeRuntime.detectGpu().then((g) => {
    gpuLine.textContent = g.available ? `GPU: ${g.name}. Model tasks will run on it through WebGPU.` : 'No WebGPU in this browser, so this tab can take compute tasks only. Chrome or Edge on a machine with a graphics card can serve model tasks.';
    if (!g.available) {
      serveModel.checked = false;
      serveModel.disabled = true;
      modelLabel.textContent = 'Serve model tasks (needs WebGPU)';
    }
  });

  const client = () => nodeRuntime.client;
  const unsubRuntime = nodeRuntime.subscribe(() => {
    const st = nodeRuntime.state;
    const map: Record<string, [string, string]> = {
      off: ['', 'Not running'],
      loading: ['loading', 'Loading model'],
      registering: ['registering', 'Registering'],
      idle: ['idle', 'Online, waiting for work'],
      working: ['working', 'Working'],
      paused: ['registering', `Paused: ${nodeRuntime.pausedReason() ?? ''}`],
      error: ['error', 'Problem'],
    };
    const [cls, text] = map[st];
    statusEl.className = `status ${cls}`;
    statusEl.lastElementChild!.textContent = text;
    if (nodeRuntime.detail) statusNote.textContent = nodeRuntime.detail;
    else if (st === 'idle') statusNote.textContent = `Online. ${nodeRuntime.tasksThisSession} task${nodeRuntime.tasksThisSession === 1 ? '' : 's'} this session. Leave this tab open; you can browse the rest of the site.`;
    else if (st === 'off') statusNote.textContent = 'Nothing to install. Press start and this tab registers as a node and takes work while it is open.';
    progress.hidden = !nodeRuntime.progress;
    if (nodeRuntime.progress) (progress.firstElementChild as HTMLElement).style.width = nodeRuntime.progress.total ? `${(nodeRuntime.progress.loaded / nodeRuntime.progress.total) * 100}%` : '0%';
    const running = nodeRuntime.running;
    startBtn.disabled = running;
    stopBtn.disabled = !running;
    [label, price, serveModel, background].forEach((i) => (i.disabled = running || (i === serveModel && !nodeRuntime.gpu.available && !running)));
    if (running) void refreshMe();
  });

  startBtn.addEventListener('click', () => {
    const p: Prefs = { label: label.value.trim() || defaultLabel(), price: Math.round((Number(price.value) || 0.25) * 1000), serveModel: serveModel.checked, background: background.checked, maxOut: 192 };
    savePrefs(p);
    void nodeRuntime.start(key, p);
  });
  stopBtn.addEventListener('click', () => nodeRuntime.stop());

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
    const c = client() ?? viewClient;
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

  const install = `git clone <repo> nightshift && cd nightshift && npm install\nNIGHTSHIFT_URL=${API_BASE || location.origin} npm run worker`;
  const pub = h('code', { class: 'small', style: { wordBreak: 'break-all' } }, key.publicKey);

  const el = h(
    'div',
    { class: 'container section' },
    h('div', { class: 'section-head reveal' }, h('h1', null, 'Earn with your hardware'), h('p', null, 'Press start and this tab becomes a node, no install. It takes tasks from businesses using the network, you are paid per task by hardware class, and you can cash out in SOL or USDC once you reach $50.')),
    h(
      'div',
      { class: 'worker reveal', 'data-delay': '1' },
      h(
        'div',
        { style: { display: 'grid', gap: '16px' } },
        h(
          'div',
          { class: 'card', style: { display: 'grid', gap: '12px' } },
          h('h3', null, 'Earn from this tab'),
          statusEl,
          statusNote,
          progress,
          gpuLine,
          h('div', { class: 'grid-2', style: { gap: '12px' } }, h('label', { class: 'field' }, h('span', null, 'Node name on the map'), label), h('label', { class: 'field' }, h('span', null, 'Your price, $ per 1M tokens'), price)),
          h('label', { class: 'row' }, serveModel, modelLabel),
          h('label', { class: 'row' }, background, h('span', null, 'Keep working when this tab is in the background')),
          h('div', { class: 'row' }, startBtn, stopBtn),
          h('p', { class: 'small muted' }, 'Pauses on low battery. Stops when the tab is closed. Task content is processed in a background thread and never shown.'),
        ),
        h(
          'div',
          { class: 'card', style: { display: 'grid', gap: '12px' } },
          h('h3', null, 'Want it running all day on a bigger model?'),
          h('p', { class: 'small muted' }, 'Run the agent on the machine instead. It serves larger models through a local model server, keeps going with the lid closed, and earns to the same kind of key.'),
          h('pre', null, h('code', null, isPreview() ? 'git clone <repo> nightshift && cd nightshift && npm install\nNIGHTSHIFT_URL=https://your-router npm run worker' : install)),
          h('div', { class: 'row' }, h('a', { class: 'btn sm secondary', href: '/docs/earning' }, 'How earnings work'), h('a', { class: 'btn sm secondary', href: '/docs/run-a-node' }, 'Agent reference')),
        ),
      ),
      h(
        'div',
        { style: { display: 'grid', gap: '16px' } },
        h('div', { class: 'card flush term-card' }, h('div', { class: 'term-bar' }, h('span'), h('span'), h('span'), h('b', null, 'nightshift earnings')), term, h('div', { style: { padding: '0 16px 16px' } }, termNote)),
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
      // The node keeps running; only the page's listeners go away.
      unsubRuntime();
      clearInterval(meTimer);
      stopReveal();
    },
  };
}
