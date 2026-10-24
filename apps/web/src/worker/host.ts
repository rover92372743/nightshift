// Page-side handle on the Web Worker. Promises in, messages out.

import type { ChatMessage, JobOutput } from '@docket/shared';

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
    this.w = new Worker(new URL('./node.worker.ts', import.meta.url), { type: 'module' });
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
