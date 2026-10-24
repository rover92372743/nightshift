// One WebSocket for the whole app. Pages subscribe and unsubscribe; the
// socket reconnects on its own with backoff and replays the last snapshot
// to new subscribers so a page that mounts late doesn't start empty.

import type { LiveEvent, NetworkStats, PublicNode } from '@docket/shared';
import { wsUrl } from './api';

type Sub = (ev: LiveEvent) => void;

class LiveFeed {
  private ws: WebSocket | null = null;
  private subs = new Set<Sub>();
  private backoff = 1000;
  private timer: number | undefined;
  private connected = false;
  private onState = new Set<(up: boolean) => void>();

  stats: NetworkStats | null = null;
  nodes = new Map<string, PublicNode>();

  subscribe(fn: Sub): () => void {
    this.subs.add(fn);
    this.ensure();
    if (this.stats) fn({ t: 'hello', stats: this.stats, nodes: Array.from(this.nodes.values()) });
    return () => this.subs.delete(fn);
  }

  state(fn: (up: boolean) => void): () => void {
    this.onState.add(fn);
    fn(this.connected);
    return () => this.onState.delete(fn);
  }

  private ensure(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    try {
      this.ws = new WebSocket(wsUrl());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws.onopen = () => {
      this.backoff = 1000;
      this.setState(true);
    };
    this.ws.onmessage = (m) => {
      let ev: LiveEvent;
      try {
        ev = JSON.parse(m.data);
      } catch {
        return;
      }
      this.apply(ev);
      for (const s of this.subs) s(ev);
    };
    this.ws.onclose = () => {
      this.setState(false);
      this.scheduleReconnect();
    };
    this.ws.onerror = () => this.ws?.close();
  }

  private apply(ev: LiveEvent): void {
    switch (ev.t) {
      case 'hello':
        this.stats = ev.stats;
        this.nodes = new Map(ev.nodes.map((n) => [n.id, n]));
        break;
      case 'stats':
        this.stats = ev.stats;
        break;
      case 'node.up':
        this.nodes.set(ev.node.id, ev.node);
        break;
      case 'node.down':
        this.nodes.delete(ev.nodeId);
        break;
      case 'node.busy': {
        const n = this.nodes.get(ev.nodeId);
        if (n) n.status = ev.busy ? 'busy' : 'online';
        break;
      }
      case 'job.done': {
        const n = this.nodes.get(ev.nodeId);
        if (n) n.jobsDone += 1;
        break;
      }
    }
  }

  private setState(up: boolean): void {
    this.connected = up;
    for (const f of this.onState) f(up);
  }

  private scheduleReconnect(): void {
    if (this.subs.size === 0) return;
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.ensure(), this.backoff);
    this.backoff = Math.min(15_000, this.backoff * 1.7);
  }
}

export const live = new LiveFeed();
