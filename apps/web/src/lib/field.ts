// The network field: a canvas scene with the router in the middle, nodes
// orbiting it by class, and packets travelling along the links. It is driven
// by real events from the live feed; when nothing is happening it breathes.
//
// Two palettes share one engine. The dark one (Network page) adds the full
// treatment: a slow starfield with pointer parallax, polar rings and a radar
// sweep, tier-coloured glowing nodes, link heat as packets travel, ripples
// from the router, sparks on completion and a legend. The light one stays
// quiet so it can sit behind text.

import type { HardwareTier, LiveEvent, NodeClass, PublicNode } from '@nightshift/shared';
import { TIER_LABEL } from '@nightshift/shared';

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
  bg: '#020305',
  link: 'rgba(143,163,255,0.10)',
  node: '#c9d2dc',
  nodeDim: '#232c3a',
  router: '#dfe6ee',
  routerInk: '#020305',
  packet: '#8fa3ff',
  receipt: '#3df28a',
  busy: '#8fa3ff',
  text: '#dfe6ee',
  textDim: '#525d6b',
  ghost: 'rgba(201,210,220,0.06)',
};

/** Hardware tiers read as a temperature scale: cool CPUs, hot datacentre cards. */
const TIER_ORDER: HardwareTier[] = ['cpu', 'gpu-8', 'gpu-16', 'gpu-24', 'gpu-48', 'gpu-80'];
const TIER_COLOR: Record<HardwareTier, string> = {
  cpu: '#8a97a8',
  'gpu-8': '#39d4c6',
  'gpu-16': '#4f8dff',
  'gpu-24': '#9b7dff',
  'gpu-48': '#e86bff',
  'gpu-80': '#ffb648',
};
const TIER_SIZE: Record<HardwareTier, number> = { cpu: 5, 'gpu-8': 6, 'gpu-16': 7, 'gpu-24': 8, 'gpu-48': 9, 'gpu-80': 10.5 };

interface FNode {
  id: string;
  cls: NodeClass;
  tier: HardwareTier;
  label: string;
  gpu: string;
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
  heat: number; // 0..1 link brightness while traffic moves on it
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

interface Star {
  x: number; // 0..1
  y: number;
  r: number;
  ph: number;
  depth: number; // 0..1, parallax strength
}

interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  color: string;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967295;
}

/** Small deterministic generator so the sky is the same on every visit. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function tierOf(n: PublicNode): HardwareTier {
  const t = n.capabilities.hardware?.tier;
  if (t) return t;
  return n.class === 'browser' ? 'gpu-8' : 'gpu-16';
}

export class Field {
  private ctx: CanvasRenderingContext2D;
  private nodes = new Map<string, FNode>();
  private packets: Packet[] = [];
  private stars: Star[] = [];
  private sparks: Spark[] = [];
  private ripples: number[] = []; // 0..1 progress of expanding rings from the router
  private raf = 0;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private t0 = performance.now();
  private pointer: { x: number; y: number; in: boolean } = { x: 0, y: 0, in: false };
  private smooth: { x: number; y: number } = { x: 0.5, y: 0.5 }; // eased pointer for parallax
  private routerPulse = 0;
  private visible = true;
  private reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  private io: IntersectionObserver;
  private ro: ResizeObserver;
  private get rich(): boolean {
    return !!this.pal.bg;
  }
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
    if (this.rich) {
      const rnd = prng(7);
      for (let i = 0; i < 180; i++) {
        const k = rnd();
        this.stars.push({ x: rnd(), y: rnd(), r: 0.4 + k * 1.1, ph: rnd() * 6.283, depth: 0.2 + rnd() * 0.8 });
      }
    }
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
        this.ripples.push(0);
        this.packets.push(this.mkPacket(() => this.edge(), () => this.center(), this.pal.packet, 'job', 700));
        break;
      case 'job.assigned': {
        const n = this.nodes.get(ev.nodeId);
        if (n) {
          n.busy = true;
          n.pulse = 1;
          n.heat = 1;
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
          n.heat = 1;
          this.burst(n.x, n.y, this.pal.receipt);
          this.packets.push(
            this.mkPacket(() => [n.x, n.y], () => this.center(), this.pal.receipt, 'receipt', 900, () => {
              this.routerPulse = 1;
              this.ripples.push(0);
              this.packets.push(this.mkPacket(() => this.center(), () => this.edge(), this.pal.receipt, 'receipt', 700));
            }),
          );
        }
        break;
      }
      case 'job.failed': {
        const n = ev.nodeId ? this.nodes.get(ev.nodeId) : null;
        if (n) {
          n.busy = false;
          this.burst(n.x, n.y, '#ff6b6b', 6);
        }
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
      ex.tier = tierOf(n);
      return;
    }
    // Reuse a ghost's slot in the same class so a real node fades in where a placeholder was.
    const ghost = Array.from(this.nodes.values()).find((g) => g.ghost && g.cls === n.class);
    if (ghost) this.nodes.delete(ghost.id);
    const f: FNode = {
      id: n.id,
      cls: n.class,
      tier: tierOf(n),
      label: n.label,
      gpu: n.capabilities.hardware?.gpu ?? '',
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
      heat: 0,
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
      this.nodes.set(id, {
        id, cls, tier: 'gpu-8', label: '', gpu: '', busy: false, jobs: 0, price: 0, angle: 0, radius: 0,
        phase: hash(id) * 6.28, x: 0, y: 0, ghost: true, born: 0, pulse: 0, hot: 0, heat: 0,
      });
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

  /** The whole constellation turns very slowly, like a sky. */
  private rot(): number {
    return this.reduced || !this.rich ? 0 : ((performance.now() - this.t0) / 1000) * 0.012;
  }

  private place(n: FNode): void {
    const [cx, cy] = this.center();
    const spread = this.opts.spread ?? 1;
    const rx = Math.min(this.w * 0.42 * spread, this.h * 0.7);
    const ry = this.h * 0.44;
    const a = n.angle + this.rot();
    n.x = cx + Math.cos(a) * n.radius * rx;
    n.y = cy + Math.sin(a) * n.radius * ry;
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

  private burst(x: number, y: number, color: string, count = 14): void {
    if (!this.rich || this.reduced) return;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * 6.283 + Math.random() * 0.4;
      const v = 0.8 + Math.random() * 1.6;
      this.sparks.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 1, color });
    }
  }

  /** Fire a visible packet for a job this page submitted, before the feed confirms it. */
  poke(): void {
    this.routerPulse = 1;
    this.ripples.push(0);
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
    const t = (now - this.t0) / 1000;
    const [cx, cy] = this.center();
    const scale = Math.max(0.75, Math.min(w, h) / 520);
    const rich = this.rich;

    if (pal.bg) {
      ctx.fillStyle = pal.bg;
      ctx.fillRect(0, 0, w, h);
    } else ctx.clearRect(0, 0, w, h);

    // eased pointer, used for parallax
    const px = this.pointer.in ? this.pointer.x / w : 0.5;
    const py = this.pointer.in ? this.pointer.y / h : 0.5;
    this.smooth.x += (px - this.smooth.x) * 0.04;
    this.smooth.y += (py - this.smooth.y) * 0.04;

    if (rich) this.drawSky(t, cx, cy, scale);

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
    glow.addColorStop(0, pal.bg ? 'rgba(143,163,255,0.12)' : 'rgba(61,79,204,0.08)');
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);

    // links curve gently so the whole thing reads as a web rather than spokes
    for (const n of this.nodes.values()) {
      const color = rich && !n.ghost ? TIER_COLOR[n.tier] : pal.busy;
      const mx = (cx + n.x) / 2 - (n.y - cy) * 0.12;
      const my = (cy + n.y) / 2 + (n.x - cx) * 0.12;
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
      ctx.strokeStyle = n.ghost ? pal.ghost : rich ? pal.link : n.busy ? pal.busy : pal.link;
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.quadraticCurveTo(mx, my, n.x, n.y);
      ctx.stroke();
      if (!n.ghost && (n.heat > 0 || n.busy)) {
        // heat: a brighter, wider line in the node's tier colour that fades after traffic
        const a = Math.max(n.heat * 0.7, n.busy ? 0.25 : 0);
        ctx.strokeStyle = color;
        ctx.globalAlpha = a;
        ctx.lineWidth = 1 + n.heat * 1.5;
        if (n.busy && !this.reduced) {
          ctx.setLineDash([3 * scale, 9 * scale]);
          ctx.lineDashOffset = -t * 60;
        }
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.quadraticCurveTo(mx, my, n.x, n.y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        n.heat = Math.max(0, n.heat - 0.006);
      }
    }

    // ripples from the router
    if (rich) {
      for (let i = this.ripples.length - 1; i >= 0; i--) {
        const k = (this.ripples[i] += this.reduced ? 1 : 0.012);
        if (k >= 1) {
          this.ripples.splice(i, 1);
          continue;
        }
        const rr = 30 * scale + k * Math.min(w, h) * 0.42;
        ctx.strokeStyle = pal.packet;
        ctx.globalAlpha = (1 - k) * 0.35;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.ellipse(cx, cy, rr, rr * 0.75, 0, 0, 6.283);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }

    // nodes
    for (const n of this.nodes.values()) {
      const base = rich ? TIER_SIZE[n.tier] : 7;
      const r = (n.ghost ? 5.5 : base + Math.min(5, Math.sqrt(n.jobs) * 0.8)) * scale;
      const age = n.born ? Math.min(1, (now - n.born) / 600) : 1;
      const tint = rich && !n.ghost ? TIER_COLOR[n.tier] : pal.node;
      if (n.pulse > 0) {
        ctx.strokeStyle = rich ? tint : pal.busy;
        ctx.globalAlpha = n.pulse * 0.6;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(n.x, n.y, r + (1 - n.pulse) * 26 * scale, 0, 6.283);
        ctx.stroke();
        ctx.globalAlpha = 1;
        n.pulse = Math.max(0, n.pulse - (this.reduced ? 1 : 0.025));
      }
      if (rich && !n.ghost) {
        // soft halo; brighter while busy, hot or hovered
        const lift = n.busy ? 0.55 : n.hot > 0 ? 0.3 + n.hot * 0.5 : n === this.hovered ? 0.6 : 0.22;
        const hr = r * (n.busy ? 4.2 : 3.2);
        const g = ctx.createRadialGradient(n.x, n.y, r * 0.4, n.x, n.y, hr);
        g.addColorStop(0, rgba(n.hot > 0 ? pal.receipt : tint, lift));
        g.addColorStop(1, rgba(tint, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(n.x, n.y, hr, 0, 6.283);
        ctx.fill();
      }
      if (n.busy && !this.reduced) {
        // a spinning broken ring says "working" better than a steady one
        ctx.strokeStyle = rich ? tint : pal.busy;
        ctx.globalAlpha = 0.9;
        ctx.lineWidth = 1.5;
        const a0 = t * 4 + n.phase;
        for (let s = 0; s < 3; s++) {
          ctx.beginPath();
          ctx.arc(n.x, n.y, r + 5 * scale, a0 + s * 2.094, a0 + s * 2.094 + 1.2);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
      // core
      if (n.ghost) ctx.fillStyle = pal.ghost;
      else if (rich) {
        const core = ctx.createRadialGradient(n.x - r * 0.3, n.y - r * 0.3, 0, n.x, n.y, r);
        const c = n.hot > 0 ? mix(tint, pal.receipt, n.hot) : tint;
        core.addColorStop(0, '#ffffff');
        core.addColorStop(0.35, n === this.hovered ? '#ffffff' : c);
        core.addColorStop(1, mix(c, '#000000', 0.45));
        ctx.fillStyle = core;
      } else {
        ctx.fillStyle = n.hot > 0 ? mix(pal.node, pal.receipt, n.hot) : n.busy ? pal.busy : pal.node;
        if (n === this.hovered) ctx.fillStyle = pal.packet;
      }
      ctx.beginPath();
      ctx.arc(n.x, n.y, r * age, 0, 6.283);
      ctx.fill();
      n.hot = Math.max(0, n.hot - 0.012);
      if (this.opts.labels && !n.ghost && n !== this.hovered && (n.busy || this.nodes.size <= 14)) {
        ctx.fillStyle = pal.textDim;
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
      if (p.trail.length > (rich ? 22 : 14)) p.trail.shift();
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
      if (rich) {
        const g = ctx.createRadialGradient(x, y, 0, x, y, 14 * scale);
        g.addColorStop(0, rgba(p.color, 0.6));
        g.addColorStop(1, rgba(p.color, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, 14 * scale, 0, 6.283);
        ctx.fill();
      }
      ctx.fillStyle = rich ? '#ffffff' : p.color;
      if (p.kind === 'receipt') {
        ctx.save();
        ctx.translate(x, y);
        ctx.fillStyle = p.color;
        ctx.fillRect(-4 * scale, -5 * scale, 8 * scale, 10 * scale);
        ctx.fillStyle = rich ? '#ffffff' : pal.routerInk;
        for (let l = 0; l < 3; l++) ctx.fillRect(-2.5 * scale, -3 * scale + l * 2.5 * scale, (l === 2 ? 3 : 5) * scale, 1);
        ctx.restore();
      } else {
        ctx.beginPath();
        ctx.arc(x, y, 3 * scale, 0, 6.283);
        ctx.fill();
      }
      if (k >= 1) {
        this.packets.splice(i, 1);
        p.onEnd?.();
      }
    }

    // sparks
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const s = this.sparks[i];
      s.x += s.vx * scale;
      s.y += s.vy * scale;
      s.vx *= 0.96;
      s.vy *= 0.96;
      s.life -= 0.025;
      if (s.life <= 0) {
        this.sparks.splice(i, 1);
        continue;
      }
      ctx.globalAlpha = s.life;
      ctx.fillStyle = s.color;
      ctx.beginPath();
      ctx.arc(s.x, s.y, 1.6 * scale * s.life + 0.4, 0, 6.283);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    this.drawRouter(t, cx, cy, scale);
    if (rich && this.opts.labels) this.drawLegend(scale);
    if (rich && this.hovered && !this.hovered.ghost) this.drawCard(this.hovered, scale);
  }

  /** Stars with parallax, two faint orbit rings and a slow radar sweep. */
  private drawSky(t: number, cx: number, cy: number, scale: number): void {
    const { ctx, w, h } = this;
    // deep-space gradient: a touch of blue toward the middle
    const sky = ctx.createRadialGradient(cx, cy * 0.9, 0, cx, cy, Math.max(w, h) * 0.75);
    sky.addColorStop(0, '#070a14');
    sky.addColorStop(0.6, '#030408');
    sky.addColorStop(1, '#010102');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);

    const ox = (this.smooth.x - 0.5) * 30;
    const oy = (this.smooth.y - 0.5) * 20;
    for (const s of this.stars) {
      const tw = this.reduced ? 0.6 : 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(t * (0.6 + s.depth) + s.ph));
      ctx.globalAlpha = tw * (0.25 + s.depth * 0.55);
      ctx.fillStyle = s.depth > 0.75 ? '#dfe6ee' : '#8fa3ff';
      ctx.beginPath();
      ctx.arc(s.x * w - ox * s.depth, s.y * h - oy * s.depth, s.r * (0.6 + s.depth * 0.6), 0, 6.283);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // orbit rings where the nodes sit
    const spread = this.opts.spread ?? 1;
    const rx = Math.min(w * 0.42 * spread, h * 0.7);
    const ry = h * 0.44;
    ctx.strokeStyle = 'rgba(143,163,255,0.08)';
    ctx.lineWidth = 1;
    for (const rad of [0.56, 0.78]) {
      ctx.setLineDash([2, 6]);
      ctx.lineDashOffset = this.reduced ? 0 : -t * 4 * (rad === 0.78 ? 1 : -1);
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx * rad, ry * rad, 0, 0, 6.283);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    // tick marks on the outer ring
    ctx.strokeStyle = 'rgba(143,163,255,0.14)';
    for (let i = 0; i < 48; i++) {
      const a = (i / 48) * 6.283 + this.rot();
      const long = i % 6 === 0;
      const r0 = 0.84;
      const r1 = long ? 0.88 : 0.86;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * rx * r0, cy + Math.sin(a) * ry * r0);
      ctx.lineTo(cx + Math.cos(a) * rx * r1, cy + Math.sin(a) * ry * r1);
      ctx.stroke();
    }

    // radar sweep
    if (!this.reduced) {
      const a = t * 0.5;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(1, ry / rx);
      const sweep = ctx.createConicGradient ? ctx.createConicGradient(a - 0.9, 0, 0) : null;
      if (sweep) {
        sweep.addColorStop(0, 'rgba(143,163,255,0)');
        sweep.addColorStop(0.14, 'rgba(143,163,255,0.09)');
        sweep.addColorStop(0.145, 'rgba(143,163,255,0)');
        sweep.addColorStop(1, 'rgba(143,163,255,0)');
        ctx.fillStyle = sweep;
        ctx.beginPath();
        ctx.arc(0, 0, rx * 0.86, 0, 6.283);
        ctx.fill();
      }
      ctx.restore();
    }
    void scale;
  }

  private drawRouter(t: number, cx: number, cy: number, scale: number): void {
    const { ctx, pal } = this;
    const rich = this.rich;
    const rs = 22 * scale;
    if (rich) {
      // halo
      const halo = ctx.createRadialGradient(cx, cy, rs * 0.5, cx, cy, rs * 3.2);
      halo.addColorStop(0, `rgba(143,163,255,${0.28 + this.routerPulse * 0.4})`);
      halo.addColorStop(1, 'rgba(143,163,255,0)');
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(cx, cy, rs * 3.2, 0, 6.283);
      ctx.fill();
      // two counter-rotating arcs: the thing is always doing something
      if (!this.reduced) {
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = pal.packet;
        ctx.globalAlpha = 0.7;
        for (let s = 0; s < 2; s++) {
          const a0 = t * 0.9 + s * Math.PI;
          ctx.beginPath();
          ctx.arc(cx, cy, rs * 1.7, a0, a0 + 1.5);
          ctx.stroke();
        }
        ctx.globalAlpha = 0.4;
        for (let s = 0; s < 3; s++) {
          const a0 = -t * 0.6 + s * 2.094;
          ctx.beginPath();
          ctx.arc(cx, cy, rs * 2.1, a0, a0 + 0.9);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
    }
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
    if (rich) {
      const body = ctx.createLinearGradient(cx - rs, cy - rs, cx + rs, cy + rs);
      body.addColorStop(0, '#ffffff');
      body.addColorStop(1, '#aab6c6');
      ctx.fillStyle = body;
    } else ctx.fillStyle = pal.router;
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
      ctx.fillText(this.opts.routerLabel, cx, cy + rs * 2.3 + 4);
    }
  }

  private drawLegend(scale: number): void {
    const { ctx, w, h } = this;
    const present = new Set(Array.from(this.nodes.values()).filter((n) => !n.ghost).map((n) => n.tier));
    const rows = TIER_ORDER.filter((t) => present.has(t));
    if (!rows.length) return;
    const fs = Math.round(11 * Math.max(0.9, scale));
    const lh = fs + 7;
    const pad = 10;
    const bw = 150;
    const bh = rows.length * lh + pad * 2 - 4;
    const x = w - bw - 16;
    const y = h - bh - 14;
    ctx.fillStyle = 'rgba(8,11,18,0.72)';
    ctx.strokeStyle = 'rgba(143,163,255,0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(x, y, bw, bh, 8);
    ctx.fill();
    ctx.stroke();
    ctx.font = `${fs}px Inter Tight, system-ui, sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    rows.forEach((tier, i) => {
      const cy = y + pad + i * lh + fs / 2;
      ctx.fillStyle = TIER_COLOR[tier];
      ctx.beginPath();
      ctx.arc(x + pad + 5, cy, TIER_SIZE[tier] * 0.45 + 1.5, 0, 6.283);
      ctx.fill();
      ctx.fillStyle = '#c7d0dc';
      ctx.fillText(TIER_LABEL[tier], x + pad + 18, cy);
    });
  }

  private drawCard(n: FNode, scale: number): void {
    const { ctx, w } = this;
    const fs = Math.round(12 * Math.max(0.9, scale));
    const lines = [n.label, n.gpu || TIER_LABEL[n.tier], `${n.jobs} task${n.jobs === 1 ? '' : 's'} · ${n.busy ? 'working' : 'idle'}`];
    ctx.font = `600 ${fs}px Inter Tight, system-ui, sans-serif`;
    let bw = ctx.measureText(lines[0]).width;
    ctx.font = `${fs - 1}px Inter Tight, system-ui, sans-serif`;
    for (const l of lines.slice(1)) bw = Math.max(bw, ctx.measureText(l).width);
    bw += 24;
    const bh = fs * 3 + 24;
    let x = n.x + 18;
    let y = n.y - bh / 2;
    if (x + bw > w - 8) x = n.x - 18 - bw;
    y = Math.max(8, Math.min(this.h - bh - 8, y));
    ctx.fillStyle = 'rgba(8,11,18,0.88)';
    ctx.strokeStyle = TIER_COLOR[n.tier];
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(x, y, bw, bh, 8);
    ctx.fill();
    ctx.stroke();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#eef1f4';
    ctx.font = `600 ${fs}px Inter Tight, system-ui, sans-serif`;
    ctx.fillText(lines[0], x + 12, y + 10);
    ctx.fillStyle = '#9aa7b8';
    ctx.font = `${fs - 1}px Inter Tight, system-ui, sans-serif`;
    ctx.fillText(lines[1], x + 12, y + 10 + fs + 4);
    ctx.fillText(lines[2], x + 12, y + 10 + (fs + 4) * 2);
  }
}

function mix(a: string, b: string, k: number): string {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return a;
  const c = pa.map((v, i) => Math.round(v + (pb[i] - v) * k));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}
function rgba(c: string, a: number): string {
  const p = parse(c);
  if (!p) return c;
  return `rgba(${p[0]},${p[1]},${p[2]},${a.toFixed(3)})`;
}
function parse(c: string): [number, number, number] | null {
  const m = c.match(/^#([0-9a-f]{6})$/i);
  if (m) {
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const r = c.match(/^rgb\((\d+),(\d+),(\d+)\)$/);
  if (r) return [+r[1], +r[2], +r[3]];
  return null;
}
