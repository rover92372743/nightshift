// Tiny in-process event bus. Everything the UI animates comes through here.

import type { LiveEvent } from '@docket/shared';

type Listener = (ev: LiveEvent) => void;

export class Live {
  private listeners = new Set<Listener>();

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(ev: LiveEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(ev);
      } catch {
        // a broken websocket shouldn't take the router down
      }
    }
  }
}
