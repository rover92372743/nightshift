// The network field: a canvas scene with the router in the middle, nodes
// orbiting it by class, and packets travelling along the links. It is driven
// by real events from the live feed; when nothing is happening it breathes.
//
// Used in the hero (light, ambient, interactive) and on the Network page
// (dark, bigger, hoverable, clickable). One engine, two palettes.

import type { LiveEvent, NodeClass, PublicNode } from '@docket/shared';

export interface FieldPalette {
  bg: string | null;
  link: string;
  node: string;
  nodeDim: string;
  router: string;
  routerInk: string;
  packet: string;
  receipt: string;
  busy: string;
  text: string;
  textDim: string;
  ghost: string;
}

export const LIGHT: FieldPalette = {
  bg: null,
  link: 'rgba(20,26,34,0.12)',
  node: '#141a22',
  nodeDim: '#b9c4d3',
  router: '#141a22',
  routerInk: '#eef1f4',
  packet: '#2745d6',
  receipt: '#1f8a4c',
  busy: '#2745d6',
  text: '#141a22',
  textDim: '#8390a3',
  ghost: 'rgba(20,26,34,0.14)',
};

export const DARK: FieldPalette = {
  bg: '#07090c',
  link: 'rgba(56,208,255,0.10)',
  node: '#cfd8e1',
  nodeDim: '#2b3542',
  router: '#e6ebef',
  routerInk: '#07090c',
  packet: '#38d0ff',
  receipt: '#3df28a',
  busy: '#38d0ff',
  text: '#e6ebef',
  textDim: '#6f7c8f',
  ghost: 'rgba(207,216,225,0.06)',
};

interface FNode {
  id: string;
  cls: NodeClass;
  label: string;
  busy: boolean;
  jobs: number;
  price: number;
  // polar home position + drift
  angle: number;
  radius: number;
  phase: number;
  x: number;
  y: number;
  ghost: boolean;
  born: number;
  pulse: number; // 0..1 decaying ring
  hot: number; // 0..1 decaying highlight after a done event
}

interface Packet {
  from: () => [number, number];
  to: () => [number, number];
  ctrl: [number, number];
  t: number;
  dur: number;
  color: string;
  kind: 'job' | 'receipt';
  onEnd?: () => void;
  trail: [number, number][];
}

const RING: Record<NodeClass, [number, number, number]> = {
  // [radius fraction, angle start, angle span] — sectors so classes read as groups
  browser: [0.62, -2.9, 2.2],
  native: [0.86, 0.35, 0.95],
  cloud: [0.95, 1.55, 0.55],
  external: [0.95, 2.35, 0.55],
};

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967295;
}

export class Field {
  private ctx: CanvasRenderingContext2D;
  private nodes = new Map<string, FNode>();
  private packets: Packet[] = [];
  private raf = 0;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private t0 = performance.now();
  private pointer: { x: number; y: number; in: boolean } = { x: 0, y: 0, in: false };
  private routerPulse = 0;
  private visible = true;
  private reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  private io: IntersectionObserver;
  private ro: ResizeObserver;
  hovered: FNode | null = null;
  onHover?: (n: { id: string; label: string; cls: NodeClass; jobs: number; price: number } | null) => void;
  onClick?: (id: string) => void;

  constructor(
    private canvas: HTMLCanvasElement,
    private pal: FieldPalette,
    private opts: { ghosts?: number; labels?: boolean; interactive?: boolean; routerLabel?: string; center?: [number, number]; spread?: number } = {},
  ) {
    this.ctx = canvas.getContext('2d')!;
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
    this.io = new IntersectionObserver(([e]) => (this.visible = e.isIntersecting), { threshold: 0.01 });
    this.io.observe(canvas);
    this.resize();
    if (opts.interactive !== false) {
      canvas.addEventListener('pointermove', (e) => {
        const r = canvas.getBoundingClientRect();
        this.pointer = { x: e.clientX - r.left, y: e.clientY - r.top, in: true };
      });
      canvas.addEventListener('pointerleave', () => (this.pointer.in = false));
      canvas.addEventListener('click', () => this.hovered && !this.hovered.ghost && this.onClick?.(this.hovered.id));
    }
    const onVis = () => (this.visible = document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onVis);
    this.loop();
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.io.disconnect();
  }

  private resize(): void {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = Math.max(1, r.width);
    this.h = Math.max(1, r.height);
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    for (const n of this.nodes.values()) this.place(n);
  }

  // --- state from the live feed ------------------------------------------

  apply(ev: LiveEvent): void {
    switch (ev.t) {
      case 'hello':
        this.setNodes(ev.nodes);
        break;
      case 'node.up':
        this.upsert(ev.node, true);
        break;
      case 'node.down':
        this.nodes.delete(ev.nodeId);
        this.fillGhosts();
        break;
      case 'node.busy': {
        const n = this.nodes.get(ev.nodeId);
        if (n) n.busy = ev.busy;
        break;
      }
      case 'job.queued':
        this.routerPulse = 1;
        this.packets.push(this.mkPacket(() => this.edge(), () => this.center(), this.pal.packet, 'job', 700));
        break;
      case 'job.assigned': {
        const n = this.nodes.get(ev.nodeId);
        if (n) {
          n.busy = true;
          n.pulse = 1;
          this.packets.push(this.mkPacket(() => this.center(), () => [n.x, n.y], this.pal.packet, 'job', 900));
        }
        break;
      }
      case 'job.done': {
        const n = this.nodes.get(ev.nodeId);
        if (n) {
          n.busy = false;
          n.jobs += 1;
          n.hot = 1;
          this.packets.push(
            this.mkPacket(() => [n.x, n.y], () => this.center(), this.pal.receipt, 'receipt', 900, () => {
              this.routerPulse = 1;
              this.packets.push(this.mkPacket(() => this.center(), () => this.edge(), this.pal.receipt, 'receipt', 700));
            }),
          );
        }
        break;
      }
      case 'job.failed': {
        const n = ev.nodeId ? this.nodes.get(ev.nodeId) : null;
        if (n) n.busy = false;
        break;
      }
    }
  }

  setNodes(list: PublicNode[]): void {
    const keep = new Set(list.map((n) => n.id));
    for (const id of Array.from(this.nodes.keys())) if (!this.nodes.get(id)!.ghost && !keep.has(id)) this.nodes.delete(id);
    for (const n of list) this.upsert(n, false);
    this.fillGhosts();
  }

  private upsert(n: PublicNode, fresh: boolean): void {
    const ex = this.nodes.get(n.id);
    if (ex) {
      ex.busy = n.status === 'busy';
      ex.label = n.label;
      ex.jobs = n.jobsDone;
      return;
    }
    // Reuse a ghost's slot in the same class so a real node fades in where a placeholder was.
    const ghost = Array.from(this.nodes.values()).find((g) => g.ghost && g.cls === n.class);
    if (ghost) this.nodes.delete(ghost.id);
    const f: FNode = {
      id: n.id,
      cls: n.class,
      label: n.label,
      busy: n.status === 'busy',
      jobs: n.jobsDone,
      price: n.capabilities.pricePer1k,
      angle: 0,
      radius: 0,
      phase: hash(n.id) * Math.PI * 2,
      x: 0,
      y: 0,
      ghost: false,
      born: fresh ? performance.now() : 0,
      pulse: fresh ? 1 : 0,
      hot: 0,
    };
    this.nodes.set(n.id, f);
    this.layoutClass(n.class);
  }

  /** Placeholders so an empty network still has shape. Drawn faint; never labelled as real. */
  private fillGhosts(): void {
    const want = this.opts.ghosts ?? 0;
    const real = Array.from(this.nodes.values()).filter((n) => !n.ghost).length;
    const ghosts = Array.from(this.nodes.values()).filter((n) => n.ghost);
    const need = Math.max(0, want - real);
    for (let i = ghosts.length; i < need; i++) {
      const cls: NodeClass = i % 6 === 5 ? 'external' : i % 6 === 4 ? 'cloud' : i % 4 === 3 ? 'native' : 'browser';
      const id = `ghost_${i}`;
      this.nodes.set(id, { id, cls, label: '', busy: false, jobs: 0, price: 0, angle: 0, radius: 0, phase: hash(id) * 6.28, x: 0, y: 0, ghost: true, born: 0, pulse: 0, hot: 0 });
    }
    for (let i = need; i < ghosts.length; i++) this.nodes.delete(ghosts[i].id);
    for (const c of ['browser', 'native', 'cloud', 'external'] as NodeClass[]) this.layoutClass(c);
  }

  /**
   * Lay every class out around the ring, each class getting a sector sized
   * by how many nodes it has (with a minimum so small classes stay visible).
   * Classes keep a fixed order so the map reads the same from visit to visit.
   */
  private layoutClass(_cls: NodeClass): void {
    const order: NodeClass[] = ['browser', 'native', 'cloud', 'external'];
    const groups = order.map((c) => Array.from(this.nodes.values()).filter((n) => n.cls === c).sort((a, b) => hash(a.id) - hash(b.id)));
    const total = groups.reduce((n, g) => n + g.length, 0) || 1;
    const minSpan = 0.35;
    const spans = groups.map((g) => (g.length ? Math.max(minSpan, (g.length / total) * (Math.PI * 2 - 0.4)) : 0));
    const sum = spans.reduce((a, b) => a + b, 0) || 1;
    const scale = (Math.PI * 2 - 0.4) / sum;
    let a = -Math.PI * 0.95;
    groups.forEach((g, i) => {
      const span = spans[i] * scale;
      // Two rings when a class is crowded, so dots don't pile on each other.
      const rings = g.length > 10 ? 2 : 1;
      g.forEach((n, j) => {
        const ring = j % rings;
        const k = g.length === 1 ? 0.5 : j / (g.length - 1);
        n.angle = a + 0.08 + k * (span - 0.16);
        n.radius = (ring === 0 ? 0.78 : 0.56) + (hash(n.id + 'r') - 0.5) * 0.1;
        this.place(n);
      });
      a += span + 0.1;
    });
  }

  private place(n: FNode): void {
    const [cx, cy] = this.center();
    const spread = this.opts.spread ?? 1;
    const rx = Math.min(this.w * 0.42 * spread, this.h * 0.7);
    const ry = this.h * 0.44;
    n.x = cx + Math.cos(n.angle) * n.radius * rx;
    n.y = cy + Math.sin(n.angle) * n.radius * ry;
  }

  private center(): [number, number] {
    const [fx, fy] = this.opts.center ?? [0.5, 0.5];
    return [this.w * fx, this.h * fy];
  }
  private edge(): [number, number] {
    return [-20, this.h * 0.55];
  }

  private mkPacket(from: () => [number, number], to: () => [number, number], color: string, kind: Packet['kind'], dur: number, onEnd?: () => void): Packet {
    const [ax, ay] = from();
    const [bx, by] = to();
    const mx = (ax + bx) / 2;
    const my = (ay + by) / 2;
    const dx = bx - ax;
    const dy = by - ay;
    const bend = 0.18 * (hash(String(ax + by)) - 0.5) * 2;
    return { from, to, ctrl: [mx - dy * bend, my + dx * bend], t: 0, dur: this.reduced ? 1 : dur, color, kind, onEnd, trail: [] };
  }

  /** Fire a visible packet for a job this page submitted, before the feed confirms it. */
  poke(): void {
    this.routerPulse = 1;
  }

  // --- render ---------------------------------------------------------------

  private loop = (): void => {
    this.raf = requestAnimationFrame(this.loop);
    if (!this.visible) return;
    this.draw(performance.now());
  };

  private draw(now: number): void {
    const { ctx, w, h, pal } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (pal.bg) {
      ctx.fillStyle = pal.bg;
      ctx.fillRect(0, 0, w, h);
    } else ctx.clearRect(0, 0, w, h);

    const t = (now - this.t0) / 1000;
    const [cx, cy] = this.center();
    const scale = Math.max(0.75, Math.min(w, h) / 520);

    // a ghost twinkles now and then so an empty network still looks like it's breathing
    if (!this.reduced && Math.random() < 0.012) {
      const ghosts = Array.from(this.nodes.values()).filter((n) => n.ghost);
      if (ghosts.length) ghosts[Math.floor(Math.random() * ghosts.length)].pulse = 0.5;
    }

    // drift
    for (const n of this.nodes.values()) {
      this.place(n);
      if (!this.reduced) {
        n.x += Math.sin(t * 0.6 + n.phase) * 4 * scale;
        n.y += Math.cos(t * 0.5 + n.phase * 1.3) * 4 * scale;
      }
      // pointer: nodes lean slightly toward the cursor
      if (this.pointer.in && !this.reduced) {
        const dx = this.pointer.x - n.x;
        const dy = this.pointer.y - n.y;
        const d = Math.hypot(dx, dy);
        if (d < 160) {
          const k = (1 - d / 160) * 10;
          n.x += (dx / d) * k;
          n.y += (dy / d) * k;
        }
      }
    }

    // hover
    let best: FNode | null = null;
    if (this.pointer.in) {
      let bd = 22 * scale + 8;
      for (const n of this.nodes.values()) {
        const d = Math.hypot(n.x - this.pointer.x, n.y - this.pointer.y);
        if (d < bd) {
          bd = d;
          best = n;
        }
      }
    }
    if (best !== this.hovered) {
      this.hovered = best;
      this.canvas.style.cursor = best && !best.ghost ? 'pointer' : 'default';
      this.onHover?.(best && !best.ghost ? { id: best.id, label: best.label, cls: best.cls, jobs: best.jobs, price: best.price } : null);
    }

    // glow behind the router
    const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.min(w, h) * 0.5);
    glow.addColorStop(0, pal.bg ? 'rgba(56,208,255,0.12)' : 'rgba(0,127,163,0.08)');
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);

    // links curve gently so the whole thing reads as a web rather than spokes
    ctx.lineWidth = 1;
    for (const n of this.nodes.values()) {
      ctx.strokeStyle = n.ghost ? pal.ghost : n.busy ? pal.busy : pal.link;
      ctx.globalAlpha = n.busy ? 0.6 : 1;
      const mx = (cx + n.x) / 2 - (n.y - cy) * 0.12;
      const my = (cy + n.y) / 2 + (n.x - cx) * 0.12;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.quadraticCurveTo(mx, my, n.x, n.y);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // nodes
    for (const n of this.nodes.values()) {
      const r = (n.ghost ? 5.5 : 7 + Math.min(7, Math.sqrt(n.jobs))) * scale;
      const age = n.born ? Math.min(1, (now - n.born) / 600) : 1;
      if (n.pulse > 0) {
        ctx.strokeStyle = pal.busy;
        ctx.globalAlpha = n.pulse * 0.6;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(n.x, n.y, r + (1 - n.pulse) * 26 * scale, 0, 6.283);
        ctx.stroke();
        ctx.globalAlpha = 1;
        n.pulse = Math.max(0, n.pulse - (this.reduced ? 1 : 0.025));
      }
      if (n.busy && !this.reduced) {
        ctx.strokeStyle = pal.busy;
        ctx.globalAlpha = 0.35 + 0.35 * Math.sin(t * 6 + n.phase);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(n.x, n.y, r + 5 * scale, 0, 6.283);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      ctx.fillStyle = n.ghost ? pal.ghost : n.hot > 0 ? mix(pal.node, pal.receipt, n.hot) : n.busy ? pal.busy : pal.node;
      if (n === this.hovered && !n.ghost) ctx.fillStyle = pal.packet;
      ctx.beginPath();
      ctx.arc(n.x, n.y, r * age, 0, 6.283);
      ctx.fill();
      n.hot = Math.max(0, n.hot - 0.012);
      if (this.opts.labels && !n.ghost && (n === this.hovered || n.busy || this.nodes.size <= 14)) {
        ctx.fillStyle = n === this.hovered ? pal.text : pal.textDim;
        ctx.font = `${Math.round(11 * Math.max(0.9, scale))}px Inter Tight, system-ui, sans-serif`;
        ctx.textAlign = n.x < cx ? 'right' : 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(n.label.slice(0, 22), n.x + (n.x < cx ? -r - 8 : r + 8), n.y);
      }
    }

    // packets
    for (let i = this.packets.length - 1; i >= 0; i--) {
      const p = this.packets[i];
      p.t += 16.7 / p.dur;
      const k = Math.min(1, p.t);
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      const [ax, ay] = p.from();
      const [bx, by] = p.to();
      const x = (1 - e) * (1 - e) * ax + 2 * (1 - e) * e * p.ctrl[0] + e * e * bx;
      const y = (1 - e) * (1 - e) * ay + 2 * (1 - e) * e * p.ctrl[1] + e * e * by;
      p.trail.push([x, y]);
      if (p.trail.length > 14) p.trail.shift();
      ctx.strokeStyle = p.color;
      ctx.lineCap = 'round';
      for (let j = 1; j < p.trail.length; j++) {
        ctx.globalAlpha = (j / p.trail.length) * 0.7;
        ctx.lineWidth = (j / p.trail.length) * 4 * scale;
        ctx.beginPath();
        ctx.moveTo(p.trail[j - 1][0], p.trail[j - 1][1]);
        ctx.lineTo(p.trail[j][0], p.trail[j][1]);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = p.color;
      if (p.kind === 'receipt') {
        // a tiny receipt: rectangle with a notched bottom
        ctx.save();
        ctx.translate(x, y);
        ctx.fillRect(-4 * scale, -5 * scale, 8 * scale, 10 * scale);
        ctx.restore();
      } else {
        ctx.beginPath();
        ctx.arc(x, y, 3.5 * scale, 0, 6.283);
        ctx.fill();
      }
      if (k >= 1) {
        this.packets.splice(i, 1);
        p.onEnd?.();
      }
    }

    // router
    const rs = 22 * scale;
    if (this.routerPulse > 0) {
      ctx.strokeStyle = pal.packet;
      ctx.globalAlpha = this.routerPulse * 0.5;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect(cx - rs - (1 - this.routerPulse) * 30, cy - rs - (1 - this.routerPulse) * 30, 2 * rs + (1 - this.routerPulse) * 60, 2 * rs + (1 - this.routerPulse) * 60, 8);
      ctx.stroke();
      ctx.globalAlpha = 1;
      this.routerPulse = Math.max(0, this.routerPulse - 0.03);
    }
    ctx.fillStyle = pal.router;
    ctx.beginPath();
    ctx.roundRect(cx - rs, cy - rs, 2 * rs, 2 * rs, 7 * scale);
    ctx.fill();
    // receipt glyph inside
    ctx.fillStyle = pal.routerInk;
    const gw = rs * 0.9;
    const gh = rs * 1.15;
    ctx.beginPath();
    ctx.moveTo(cx - gw / 2, cy - gh / 2);
    ctx.lineTo(cx + gw / 2, cy - gh / 2);
    ctx.lineTo(cx + gw / 2, cy + gh / 2);
    for (let i = 0; i < 6; i++) ctx.lineTo(cx + gw / 2 - (gw / 6) * (i + 0.5), cy + gh / 2 - (i % 2 ? 0 : 3 * scale));
    ctx.lineTo(cx - gw / 2, cy + gh / 2);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = pal.router;
    for (let i = 0; i < 3; i++) ctx.fillRect(cx - gw * 0.3, cy - gh * 0.3 + i * gh * 0.22, gw * (i === 2 ? 0.4 : 0.6), 2 * scale);
    if (this.opts.routerLabel) {
      ctx.fillStyle = pal.textDim;
      ctx.font = `${Math.round(11 * Math.max(0.9, scale))}px Inter Tight, system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(this.opts.routerLabel, cx, cy + rs + 8);
    }
  }
}

function mix(a: string, b: string, k: number): string {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return a;
  const c = pa.map((v, i) => Math.round(v + (pb[i] - v) * k));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}
function parse(c: string): [number, number, number] | null {
  const m = c.match(/^#([0-9a-f]{6})$/i);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
