// Page-side handle on the Web Worker. Promises in, messages out.

import { computeTask, type ChatMessage, type JobOutput } from '@nightshift/shared';
import { isPreview } from '../lib/dom';

export interface LoadProgress {
  file: string;
  progress: number;
  loaded: number;
  total: number;
}

export class WorkerHost {
  private w: Worker;
  private pending = new Map<string, { resolve: (o: JobOutput) => void; reject: (e: Error) => void; onToken?: (t: string) => void }>();
  private loadWaiters: { resolve: (d: string) => void; reject: (e: Error) => void }[] = [];
  loaded = false;
  device = '';
  onProgress?: (p: LoadProgress) => void;

  constructor() {
    if (isPreview()) {
      // Single-file preview: no separate worker script, so compute runs on the
      // main thread and the model is a stand-in that says so.
      this.w = inlineWorker();
    } else this.w = new Worker(new URL('./node.worker.ts', import.meta.url), { type: 'module' });
    this.w.onmessage = (e: MessageEvent) => {
      const m = e.data;
      switch (m.type) {
        case 'progress':
          this.onProgress?.(m);
          break;
        case 'loaded':
          this.loaded = true;
          this.device = m.device;
          this.loadWaiters.splice(0).forEach((x) => x.resolve(m.device));
          break;
        case 'loadError':
          this.loadWaiters.splice(0).forEach((x) => x.reject(new Error(m.message)));
          break;
        case 'token':
          this.pending.get(m.id)?.onToken?.(m.text);
          break;
        case 'result': {
          const p = this.pending.get(m.id);
          this.pending.delete(m.id);
          p?.resolve({ text: m.text, digest: m.digest, outputTokens: m.outputTokens, units: 0, durationMs: m.durationMs });
          break;
        }
        case 'error': {
          const p = this.pending.get(m.id);
          this.pending.delete(m.id);
          p?.reject(new Error(m.message));
          break;
        }
      }
    };
  }

  loadModel(model: string): Promise<string> {
    if (this.loaded) return Promise.resolve(this.device);
    return new Promise((resolve, reject) => {
      this.loadWaiters.push({ resolve, reject });
      this.w.postMessage({ type: 'load', model });
    });
  }

  generate(messages: ChatMessage[], maxNewTokens: number, temperature: number, onToken?: (t: string) => void): Promise<JobOutput> {
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onToken });
      this.w.postMessage({ type: 'generate', id, messages, maxNewTokens, temperature });
    });
  }

  compute(seed: number, rounds: number): Promise<JobOutput> {
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.w.postMessage({ type: 'compute', id, seed, rounds });
    });
  }

  terminate(): void {
    this.w.terminate();
  }
}

/** A fake Worker that runs compute inline and answers llm jobs with a stand-in. Preview only. */
function inlineWorker(): Worker {
  const listeners: ((e: MessageEvent) => void)[] = [];
  const w = {
    onmessage: null as ((e: MessageEvent) => void) | null,
    postMessage(m: { type: string; id?: string; messages?: ChatMessage[]; maxNewTokens?: number; seed?: number; rounds?: number }) {
      const reply = (data: unknown) => setTimeout(() => w.onmessage?.({ data } as MessageEvent), 0);
      if (m.type === 'load') setTimeout(() => reply({ type: 'loaded', device: 'preview' }), 600);
      else if (m.type === 'compute') {
        const t0 = performance.now();
        computeTask(m.seed ?? 0, m.rounds ?? 0).then((digest) => reply({ type: 'result', id: m.id, digest, outputTokens: 0, durationMs: performance.now() - t0 }));
      } else if (m.type === 'generate') {
        const text = 'This tab is a node in the preview. On the real network it would be running a small model right now; here it signs a stand-in reply so the rest of the flow is real.';
        const toks = Math.min(m.maxNewTokens ?? 64, Math.ceil(text.length / 4));
        let i = 0;
        const iv = setInterval(() => {
          i += 3;
          reply({ type: 'token', id: m.id, text: text.slice(i - 3, i) });
          if (i >= text.length) {
            clearInterval(iv);
            reply({ type: 'result', id: m.id, text, outputTokens: toks, durationMs: 1200 });
          }
        }, 30);
      }
    },
    terminate() {},
    addEventListener(_t: string, f: (e: MessageEvent) => void) {
      listeners.push(f);
    },
  };
  return w as unknown as Worker;
}
