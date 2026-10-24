import { NodeClient, runWorker, COMPUTE_ROUNDS_PER_UNIT, type JobRecord, type Receipt, type Workload, type LedgerEntry } from '@docket/shared';
import { h, clear, fmtCr, fmtMs, mountReveals, timeHM, copyText } from '../lib/dom';
import { API_BASE } from '../lib/api';
import { loadOrCreateNodeKey } from '../lib/keys';
import { WorkerHost } from '../worker/host';
import { Field, LIGHT } from '../lib/field';
import { live } from '../lib/live';
import type { Page } from '../main';

const MODEL = 'qwen2.5-0.5b-instruct';
const PREFS = 'docket.node.prefs';

interface Prefs {
  label: string;
  price: number;
  llm: boolean;
  compute: boolean;
  maxOut: number;
}

function loadPrefs(): Prefs {
  const d: Prefs = { label: defaultLabel(), price: 250, llm: true, compute: true, maxOut: 192 };
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
  const ua = navigator.userAgent;
  const os = /Mac/.test(ua) ? 'mac' : /Windows/.test(ua) ? 'windows' : /Linux/.test(ua) ? 'linux' : 'device';
  const br = /Edg\//.test(ua) ? 'edge' : /Chrome\//.test(ua) ? 'chrome' : /Firefox\//.test(ua) ? 'firefox' : /Safari\//.test(ua) ? 'safari' : 'browser';
  return `${br} on ${os}`;
}

export function earnPage(): Page {
  const prefs = loadPrefs();
  const key = loadOrCreateNodeKey();

  // --- controls ------------------------------------------------------------
  const label = h('input', { class: 'input', value: prefs.label, maxlength: 48 }) as HTMLInputElement;
  const price = h('input', { class: 'input', type: 'number', min: 200, max: 100000, step: 10, value: prefs.price }) as HTMLInputElement;
  const maxOut = h('input', { class: 'input', type: 'number', min: 16, max: 1024, step: 16, value: prefs.maxOut }) as HTMLInputElement;
  const llm = h('input', { type: 'checkbox', checked: prefs.llm }) as HTMLInputElement;
  const compute = h('input', { type: 'checkbox', checked: prefs.compute }) as HTMLInputElement;
  const startBtn = h('button', { class: 'btn stamp' }, 'Start node') as HTMLButtonElement;
  const stopBtn = h('button', { class: 'btn secondary', disabled: true }, 'Stop') as HTMLButtonElement;

  const statusEl = h('div', { class: 'status' }, h('i'), h('span', null, 'Not running'));
  const miniCanvas = h('canvas', { class: 'mini-field tall', 'aria-hidden': 'true' });
  const mini = new Field(miniCanvas, LIGHT, { ghosts: 0, labels: true, interactive: true, routerLabel: 'router' });
  const unsubLive = live.subscribe((ev) => mini.apply(ev));
  const statusNote = h('p', { class: 'small muted' }, 'Start the node and this tab will take jobs while it is in the foreground.');
  const progress = h('div', { class: 'bar', style: { display: 'none' } }, h('i'));
  const progressText = h('p', { class: 'small muted', style: { display: 'none' } });

  const setStatus = (cls: string, text: string, note?: string) => {
    statusEl.className = `status ${cls}`;
    statusEl.lastElementChild!.textContent = text;
    if (note !== undefined) statusNote.textContent = note;
  };

  // --- earnings ------------------------------------------------------------
  const balance = h('div', { class: 'earn-big' }, '0 µcr', h('small', null, 'earned'));
  const kv = h('div', { class: 'kv' });
  const jobs = h('div', { class: 'joblist' });
  const current = h('div', { class: 'msg assistant', style: { display: 'none', fontFamily: 'var(--mono)', fontSize: '13px', maxHeight: '160px', overflow: 'auto' } });

  function renderMe(me: { node: { jobsDone: number; jobsFailed: number; unitsVerified: number; earnedMicro: number }; balanceMicro: number; ledger: LedgerEntry[]; jobs: JobRecord[] }): void {
    balance.firstChild!.textContent = fmtCr(me.node.earnedMicro);
    clear(kv);
    kv.append(
      h('span', null, 'spendable balance'), h('span', null, `${fmtCr(me.balanceMicro)}`),
      h('span', null, 'jobs done'), h('span', null, String(me.node.jobsDone)),
      h('span', null, 'jobs failed'), h('span', null, String(me.node.jobsFailed)),
      h('span', null, 'work units verified'), h('span', null, String(me.node.unitsVerified)),
    );
    clear(jobs);
    for (const j of me.jobs.slice(0, 8)) {
      jobs.appendChild(
        h('div', null, h('span', null, `${timeHM(j.createdAt)} · ${j.input.workload} · ${j.status}`), h('span', null, j.output ? fmtMs(j.output.durationMs) : ''), h('span', null, j.costMicro ? `${fmtCr(j.costMicro)}` : '')),
      );
    }
    if (!me.jobs.length) jobs.appendChild(h('div', { class: 'empty' }, 'No jobs yet. They show up here as they finish.'));
  }

  // --- payout --------------------------------------------------------------
  const payAmount = h('input', { class: 'input', type: 'number', min: 0.000001, step: 0.01, placeholder: '0.50' }) as HTMLInputElement;
  const payRail = h('select', { class: 'select' }, h('option', { value: 'credits' }, 'Keep as credits (spend on inference)'), h('option', { value: 'usdc' }, 'USDC on Solana'), h('option', { value: 'sol' }, 'SOL')) as HTMLSelectElement;
  const payAddr = h('input', { class: 'input mono', placeholder: 'Solana address', style: { display: 'none' } }) as HTMLInputElement;
  const payBtn = h('button', { class: 'btn secondary', disabled: true }, 'Request payout') as HTMLButtonElement;
  const payNote = h('p', { class: 'small muted' }, 'Off-platform rails on this router are recorded and settled by the operator by hand. You will see the request as pending until then.');
  payRail.addEventListener('change', () => (payAddr.style.display = payRail.value === 'credits' ? 'none' : ''));

  // --- the node ------------------------------------------------------------
  let client: NodeClient | null = null;
  let host: WorkerHost | null = null;
  let abort: AbortController | null = null;
  let meTimer: number | undefined;
  let batteryLow = false;

  const shouldWork = () => document.visibilityState === 'visible' && !batteryLow;

  async function start(): Promise<void> {
    const p: Prefs = { label: label.value.trim() || defaultLabel(), price: Number(price.value) || 250, llm: llm.checked, compute: compute.checked, maxOut: Number(maxOut.value) || 192 };
    if (!p.llm && !p.compute) {
      setStatus('error', 'Pick a workload', 'Enable at least one of the two workloads.');
      return;
    }
    savePrefs(p);
    startBtn.disabled = true;
    [label, price, maxOut, llm, compute].forEach((i) => (i.disabled = true));

    host = new WorkerHost();
    if (p.llm) {
      setStatus('loading', 'Loading model', 'Downloading a small model the first time (a few hundred MB). It is cached by the browser afterwards.');
      progress.style.display = '';
      progressText.style.display = '';
      const files = new Map<string, [number, number]>();
      host.onProgress = (pr) => {
        files.set(pr.file, [pr.loaded, pr.total]);
        let l = 0, t = 0;
        for (const [a, b] of files.values()) (l += a), (t += b);
        (progress.firstElementChild as HTMLElement).style.width = t ? `${(l / t) * 100}%` : '0%';
        progressText.textContent = `${(l / 1048576).toFixed(0)} / ${(t / 1048576).toFixed(0)} MB`;
      };
      try {
        const device = await host.loadModel(MODEL);
        progressText.textContent = `Model ready on ${device === 'webgpu' ? 'WebGPU' : 'CPU (wasm)'}.`;
        progress.style.display = 'none';
      } catch (err) {
        setStatus('error', 'Model failed to load', (err as Error).message + (p.compute ? ' Continuing with compute jobs only.' : ''));
        progress.style.display = 'none';
        if (!p.compute) {
          stop();
          return;
        }
        p.llm = false;
      }
    }

    const workloads: Workload[] = [];
    if (p.llm) workloads.push('llm');
    if (p.compute) workloads.push('compute');

    client = new NodeClient({
      baseUrl: API_BASE,
      signer: key,
      class: 'browser',
      label: p.label,
      capabilities: { workloads, models: p.llm ? [MODEL] : [], maxPromptChars: 6000, maxOutputTokens: p.maxOut, pricePer1k: p.price, tokensPerSec: host.device === 'webgpu' ? 25 : 6 },
    });

    abort = new AbortController();
    stopBtn.disabled = false;
    payBtn.disabled = false;

    const work = async (job: JobRecord) => {
      if (job.input.workload === 'llm') {
        current.style.display = '';
        current.textContent = '';
        const out = await host!.generate(job.input.messages ?? [], Math.min(job.input.maxOutputTokens ?? 128, p.maxOut), job.input.temperature ?? 0.7, (t) => {
          current.textContent += t;
          current.scrollTop = current.scrollHeight;
        });
        out.units = out.outputTokens;
        return out;
      }
      const out = await host!.compute(job.input.seed ?? 0, job.input.rounds ?? 0);
      out.units = Math.ceil((job.input.rounds ?? 0) / COMPUTE_ROUNDS_PER_UNIT);
      return out;
    };

    runWorker(
      client,
      work,
      {
        status: (s, d) => {
          if (s === 'registering') setStatus('registering', 'Registering', 'Telling the router this tab exists.');
          if (s === 'idle') setStatus('idle', 'Online, waiting for work', shouldWork() ? 'Jobs will arrive when someone asks for what this node serves.' : 'Paused while the tab is hidden.');
          if (s === 'working') setStatus('working', 'Working', `Running ${d}`);
          if (s === 'error') setStatus('error', 'Connection trouble', d ?? 'Retrying.');
          if (s === 'offline') setStatus('', 'Not running', 'Stopped.');
        },
        done: (_j: JobRecord, r: Receipt) => {
          current.style.display = 'none';
          statusNote.textContent = `Receipt ${r.id.slice(0, 16)} issued · ${r.body.units} units · ${fmtCr(r.body.costMicro)}`;
          void refreshMe();
        },
        failed: (_j, why) => {
          current.style.display = 'none';
          statusNote.textContent = `Job failed: ${why}`;
        },
      },
      { shouldWork, signal: abort.signal },
    ).catch((err) => setStatus('error', 'Could not start', (err as Error).message));

    meTimer = window.setInterval(() => void refreshMe(), 10_000);
    setTimeout(() => void refreshMe(), 1500);
  }

  async function refreshMe(): Promise<void> {
    if (!client?.node) return;
    try {
      renderMe((await client.me()) as Parameters<typeof renderMe>[0]);
    } catch {
      /* transient */
    }
  }

  function stop(): void {
    abort?.abort();
    abort = null;
    host?.terminate();
    host = null;
    client = null;
    clearInterval(meTimer);
    stopBtn.disabled = true;
    startBtn.disabled = false;
    payBtn.disabled = true;
    [label, price, maxOut, llm, compute].forEach((i) => (i.disabled = false));
    setStatus('', 'Not running', 'Stopped. The router will mark this node offline in about half a minute.');
  }

  startBtn.addEventListener('click', () => void start());
  stopBtn.addEventListener('click', stop);

  payBtn.addEventListener('click', async () => {
    if (!client) return;
    const amount = Math.round(Number(payAmount.value) * 1_000_000);
    payBtn.disabled = true;
    try {
      const p = (await client.requestPayout(amount, payRail.value as 'credits' | 'usdc' | 'sol', payAddr.value.trim() || undefined)) as { status: string; id: string };
      payNote.textContent = p.status === 'sent' ? 'Done. Credits stay in your balance and can be spent on inference.' : `Recorded as ${p.status} (${p.id}). The operator settles these by hand.`;
      void refreshMe();
    } catch (err) {
      payNote.textContent = (err as Error).message;
    } finally {
      payBtn.disabled = false;
    }
  });

  // Pause on low battery when the browser tells us.
  const nav = navigator as Navigator & { getBattery?: () => Promise<{ level: number; charging: boolean; addEventListener(t: string, f: () => void): void }> };
  nav.getBattery?.().then((b) => {
    const upd = () => (batteryLow = b.level < 0.2 && !b.charging);
    upd();
    b.addEventListener('levelchange', upd);
    b.addEventListener('chargingchange', upd);
  }).catch(() => {});

  const onVis = () => {
    if (client && abort) setStatus(shouldWork() ? 'idle' : 'registering', shouldWork() ? 'Online, waiting for work' : 'Paused', shouldWork() ? 'Back in the foreground.' : 'Paused while the tab is hidden. The router will not send work here.');
  };
  document.addEventListener('visibilitychange', onVis);

  const pub = h('code', { class: 'small', style: { wordBreak: 'break-all' } }, key.publicKey);

  const el = h(
    'div',
    { class: 'container section' },
    h('div', { class: 'section-head reveal' }, h('h1', null, 'Put this tab to work'), h('p', null, 'Press start and this browser becomes a node. It takes jobs only while the tab is visible and the battery is not low, and it earns credits for every receipt it signs.')),
    h(
      'div',
      { class: 'worker reveal', 'data-delay': '1' },
      h(
        'div',
        { class: 'card', style: { display: 'grid', gap: '16px' } },
        statusEl,
        statusNote,
        miniCanvas,
        progress,
        progressText,
        current,
        h('label', { class: 'field' }, h('span', null, 'Node name (shown on the network map)'), label),
        h('div', { class: 'grid-2', style: { gap: '12px' } }, h('label', { class: 'field' }, h('span', null, 'Your price, µcr per 1k tokens or units'), price), h('label', { class: 'field' }, h('span', null, 'Max output tokens per job'), maxOut)),
        h('div', { class: 'row' }, h('label', { class: 'row' }, llm, ' Serve the chat model (WebGPU or CPU)'), h('label', { class: 'row' }, compute, ' Serve compute jobs')),
        h('div', { class: 'row' }, startBtn, stopBtn),
        h('hr', { class: 'rule' }),
        h('p', { class: 'small muted' }, 'This node is identified by a key that lives in this browser. Clear site data and you start over with a new node and a zero balance.'),
        pub,
        h('div', { class: 'row' }, h('button', { class: 'btn sm secondary', onClick: () => copyText(key.publicKey) }, 'Copy public key')),
      ),
      h(
        'div',
        { style: { display: 'grid', gap: '16px' } },
        h('div', { class: 'card', style: { display: 'grid', gap: '14px' } }, h('p', { class: 'small muted' }, 'Lifetime earnings'), balance, kv),
        h('div', { class: 'card' }, h('h3', { style: { marginBottom: '10px' } }, 'Recent jobs'), jobs),
        h(
          'div',
          { class: 'card', style: { display: 'grid', gap: '12px' } },
          h('h3', null, 'Payout'),
          h('div', { class: 'grid-2', style: { gap: '12px' } }, h('label', { class: 'field' }, h('span', null, 'Amount, credits'), payAmount), h('label', { class: 'field' }, h('span', null, 'Rail'), payRail)),
          payAddr,
          h('div', { class: 'row' }, payBtn),
          payNote,
        ),
      ),
    ),
  );
  jobs.appendChild(h('div', { class: 'empty' }, 'Start the node to see jobs here.'));
  const stopReveal = mountReveals(el);

  return {
    el,
    title: 'Earn',
    unmount() {
      // Leaving the page stops the node. Running a worker from a hidden
      // route the user cannot see would be surprising.
      stop();
      unsubLive();
      mini.destroy();
      document.removeEventListener('visibilitychange', onVis);
      stopReveal();
    },
  };
}
