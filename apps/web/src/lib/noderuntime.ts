// The in-browser node, as a singleton that outlives the Earn page. Start it
// there, browse the rest of the site, and it keeps taking work. Closing the
// tab is the only thing that stops it for good.
//
// What runs here: compute tasks always; model tasks when WebGPU is available
// and the person ticked the box. Both run in a Web Worker so the page never
// stutters. The tab never shows task content.

import type { BenchResult, RegionKey } from '@nightshift/shared';
import { NodeClient, runWorker, COMPUTE_ROUNDS_PER_UNIT, type JobRecord, type Receipt, type Signer, type Workload, type HardwareTier } from '@nightshift/shared';
import { API_BASE } from './api';
import { WorkerHost } from '../worker/host';

export const BROWSER_MODEL = 'qwen2.5-0.5b-instruct';

export type NodeState = 'off' | 'loading' | 'registering' | 'idle' | 'working' | 'paused' | 'error';

export interface NodeSettings {
  label: string;
  price: number;
  serveModel: boolean;
  background: boolean;
  maxOut: number;
}

export interface GpuInfo {
  available: boolean;
  name?: string;
  tier: HardwareTier;
}

type Listener = () => void;

class NodeRuntime {
  state: NodeState = 'off';
  detail = '';
  progress: { loaded: number; total: number } | null = null;
  device = '';
  gpu: GpuInfo = { available: false, tier: 'cpu' };
  client: NodeClient | null = null;
  lastReceipt: Receipt | null = null;
  tasksThisSession = 0;

  private host: WorkerHost | null = null;
  private abort: AbortController | null = null;
  private listeners = new Set<Listener>();
  private batteryLow = false;
  private settings: NodeSettings | null = null;

  constructor() {
    document.addEventListener('visibilitychange', () => this.emit());
    const nav = navigator as Navigator & { getBattery?: () => Promise<{ level: number; charging: boolean; addEventListener(t: string, f: () => void): void }> };
    nav.getBattery?.().then((b) => {
      const upd = () => {
        this.batteryLow = b.level < 0.2 && !b.charging;
        this.emit();
      };
      upd();
      b.addEventListener('levelchange', upd);
      b.addEventListener('chargingchange', upd);
    }).catch(() => {});
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn();
    return () => this.listeners.delete(fn);
  }
  private emit(): void {
    for (const f of this.listeners) f();
  }
  private set(state: NodeState, detail = ''): void {
    this.state = state;
    this.detail = detail;
    this.emit();
  }

  get running(): boolean {
    return this.state !== 'off';
  }

  /** Why the node isn't taking work right now, or null if it is. */
  pausedReason(): string | null {
    if (!this.settings) return null;
    if (this.batteryLow) return 'battery under 20% and not charging';
    if (document.visibilityState !== 'visible' && !this.settings.background) return 'tab is hidden';
    return null;
  }

  async detectGpu(): Promise<GpuInfo> {
    const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<{ info?: { description?: string; vendor?: string; device?: string }; requestAdapterInfo?(): Promise<{ description?: string; vendor?: string; device?: string }> } | null> } }).gpu;
    if (!gpu) return (this.gpu = { available: false, tier: 'cpu' });
    try {
      const adapter = await gpu.requestAdapter();
      if (!adapter) return (this.gpu = { available: false, tier: 'cpu' });
      const info = adapter.info ?? (await adapter.requestAdapterInfo?.()) ?? {};
      const name = [info.description, info.vendor, info.device].filter(Boolean).join(' ').trim() || 'WebGPU adapter';
      // WebGPU doesn't expose memory. Browser nodes serve small models, so the
      // 8 GB class is the honest ceiling regardless of the card.
      return (this.gpu = { available: true, name, tier: 'gpu-8' });
    } catch {
      return (this.gpu = { available: false, tier: 'cpu' });
    }
  }

  async start(signer: Signer, settings: NodeSettings, benchmark?: BenchResult): Promise<void> {
    if (this.running) return;
    this.settings = settings;
    this.tasksThisSession = 0;
    await this.detectGpu();
    this.host = new WorkerHost();

    let serveModel = settings.serveModel && this.gpu.available;
    if (serveModel) {
      this.set('loading', 'Fetching the model the first time; the browser caches it after that.');
      this.host.onProgress = (p) => {
        const files = (this.progress ??= { loaded: 0, total: 0 });
        files.loaded = p.loaded;
        files.total = p.total;
        this.emit();
      };
      try {
        this.device = await this.host.loadModel(BROWSER_MODEL);
      } catch (err) {
        serveModel = false;
        this.set('error', `Model failed to load (${(err as Error).message}). Serving compute tasks only.`);
      }
      this.progress = null;
    }

    const workloads: Workload[] = serveModel ? ['llm', 'compute'] : ['compute'];
    this.client = new NodeClient({
      baseUrl: API_BASE,
      signer,
      class: 'browser',
      label: settings.label,
      capabilities: {
        workloads,
        models: serveModel ? [BROWSER_MODEL] : [],
        maxPromptChars: 6000,
        maxOutputTokens: settings.maxOut,
        pricePer1k: settings.price,
        tokensPerSec: this.device === 'webgpu' ? 25 : 6,
        hardware: { gpu: this.gpu.name, tier: serveModel ? this.gpu.tier : 'cpu' },
        region: regionFromTimezone(),
      },
      benchmark,
    });

    this.abort = new AbortController();
    const host = this.host;
    const work = async (job: JobRecord) => {
      if (job.input.workload === 'llm') {
        const out = await host.generate(job.input.messages ?? [], Math.min(job.input.maxOutputTokens ?? 128, settings.maxOut), job.input.temperature ?? 0.7);
        out.units = out.outputTokens;
        return out;
      }
      const out = await host.compute(job.input.seed ?? 0, job.input.rounds ?? 0);
      out.units = Math.ceil((job.input.rounds ?? 0) / COMPUTE_ROUNDS_PER_UNIT);
      return out;
    };

    runWorker(
      this.client,
      work,
      {
        status: (s, d) => {
          if (s === 'registering') this.set('registering');
          if (s === 'idle') {
            this.set(this.pausedReason() ? 'paused' : 'idle');
            markBenched(signer.publicKey);
          }
          if (s === 'working') this.set('working', d ?? '');
          if (s === 'error') this.set('error', d ?? 'retrying');
          if (s === 'offline') this.set('off');
        },
        done: (_j, r) => {
          this.lastReceipt = r;
          this.tasksThisSession++;
          this.emit();
        },
        failed: (_j, why) => this.set('idle', `last task failed: ${why}`),
      },
      { shouldWork: () => this.pausedReason() === null, signal: this.abort.signal, sleep: workerSleep },
    ).catch((err) => this.set('error', (err as Error).message));
  }

  stop(): void {
    this.abort?.abort();
    this.abort = null;
    this.host?.terminate();
    this.host = null;
    this.client = null;
    this.settings = null;
    this.set('off');
  }
}

export const nodeRuntime = new NodeRuntime();

/** Keys the router has already measured, so a returning tab can start without running the benchmark again. */
const BENCHED = 'nightshift.benched';
export function isBenched(publicKey: string): boolean {
  try {
    return (JSON.parse(localStorage.getItem(BENCHED) ?? '{}') as Record<string, number>)[publicKey] !== undefined;
  } catch {
    return false;
  }
}
export function markBenched(publicKey: string): void {
  try {
    const all = JSON.parse(localStorage.getItem(BENCHED) ?? '{}') as Record<string, number>;
    if (all[publicKey]) return;
    all[publicKey] = Date.now();
    localStorage.setItem(BENCHED, JSON.stringify(all));
  } catch {
    /* ignore */
  }
}

/**
 * A sleep that keeps time in a Web Worker. Chrome slows a hidden tab's own
 * timers to once a minute after a few minutes; worker timers are left alone,
 * so the node's heartbeat and polling keep their rhythm in the background.
 */
let ticker: Worker | null = null;
let tickId = 0;
const tickWaiters = new Map<number, () => void>();
function getTicker(): Worker | null {
  if (ticker) return ticker;
  try {
    const src = 'onmessage=(e)=>{setTimeout(()=>postMessage(e.data.id),e.data.ms)}';
    ticker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    ticker.onmessage = (e: MessageEvent<number>) => {
      const r = tickWaiters.get(e.data);
      tickWaiters.delete(e.data);
      r?.();
    };
    return ticker;
  } catch {
    return null;
  }
}
export function workerSleep(ms: number): Promise<void> {
  const w = getTicker();
  if (!w) return new Promise((r) => setTimeout(r, ms));
  return new Promise((resolve) => {
    const id = ++tickId;
    tickWaiters.set(id, resolve);
    w.postMessage({ id, ms });
  });
}

/**
 * A coarse region from the browser's timezone, so a tab shows up on the globe
 * without asking for location. A timezone is a city-sized hint at best, which
 * is exactly as precise as the region list goes.
 */
const TZ_REGION: Record<string, RegionKey> = {
  'America/Toronto': 'toronto', 'America/Montreal': 'montreal', 'America/Vancouver': 'vancouver', 'America/Edmonton': 'vancouver', 'America/Winnipeg': 'chicago', 'America/Halifax': 'montreal',
  'America/New_York': 'new-york', 'America/Detroit': 'chicago', 'America/Chicago': 'chicago', 'America/Denver': 'denver', 'America/Phoenix': 'denver', 'America/Los_Angeles': 'los-angeles',
  'America/Mexico_City': 'mexico-city', 'America/Sao_Paulo': 'sao-paulo', 'America/Argentina/Buenos_Aires': 'buenos-aires', 'America/Santiago': 'santiago', 'America/Bogota': 'miami', 'America/Lima': 'santiago',
  'Europe/London': 'london', 'Europe/Dublin': 'dublin', 'Europe/Lisbon': 'madrid', 'Europe/Madrid': 'madrid', 'Europe/Paris': 'paris', 'Europe/Brussels': 'amsterdam', 'Europe/Amsterdam': 'amsterdam',
  'Europe/Berlin': 'frankfurt', 'Europe/Zurich': 'frankfurt', 'Europe/Vienna': 'frankfurt', 'Europe/Prague': 'frankfurt', 'Europe/Rome': 'milan', 'Europe/Stockholm': 'stockholm', 'Europe/Oslo': 'stockholm',
  'Europe/Copenhagen': 'stockholm', 'Europe/Helsinki': 'helsinki', 'Europe/Warsaw': 'warsaw', 'Europe/Kyiv': 'warsaw', 'Europe/Istanbul': 'istanbul', 'Europe/Athens': 'istanbul',
  'Asia/Dubai': 'dubai', 'Asia/Jerusalem': 'tel-aviv', 'Asia/Tel_Aviv': 'tel-aviv', 'Africa/Cairo': 'cairo', 'Africa/Lagos': 'lagos', 'Africa/Nairobi': 'nairobi', 'Africa/Johannesburg': 'johannesburg',
  'Asia/Kolkata': 'mumbai', 'Asia/Calcutta': 'mumbai', 'Asia/Singapore': 'singapore', 'Asia/Jakarta': 'jakarta', 'Asia/Kuala_Lumpur': 'singapore', 'Asia/Bangkok': 'singapore', 'Asia/Manila': 'hong-kong',
  'Asia/Hong_Kong': 'hong-kong', 'Asia/Shanghai': 'hong-kong', 'Asia/Taipei': 'taipei', 'Asia/Seoul': 'seoul', 'Asia/Tokyo': 'tokyo',
  'Australia/Sydney': 'sydney', 'Australia/Melbourne': 'melbourne', 'Australia/Brisbane': 'sydney', 'Australia/Perth': 'singapore', 'Pacific/Auckland': 'auckland',
};
export function regionFromTimezone(): RegionKey | undefined {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return TZ_REGION[tz];
  } catch {
    return undefined;
  }
}
