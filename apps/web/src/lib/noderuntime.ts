// The in-browser node, as a singleton that outlives the Earn page. Start it
// there, browse the rest of the site, and it keeps taking work. Closing the
// tab is the only thing that stops it for good.
//
// What runs here: compute tasks always; model tasks when WebGPU is available
// and the person ticked the box. Both run in a Web Worker so the page never
// stutters. The tab never shows task content.

import { NodeClient, runWorker, COMPUTE_ROUNDS_PER_UNIT, type JobRecord, type Receipt, type Signer, type Workload, type HardwareTier } from '@docket/shared';
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

  async start(signer: Signer, settings: NodeSettings): Promise<void> {
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
      },
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
          if (s === 'idle') this.set(this.pausedReason() ? 'paused' : 'idle');
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
      { shouldWork: () => this.pausedReason() === null, signal: this.abort.signal },
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
