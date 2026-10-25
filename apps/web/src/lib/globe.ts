// The globe on the Network page. A slowly turning dotted Earth; every lit
// point is a metro area with nodes in it. The router orbits as a small
// satellite and work flows between it and the ground. Hover a hub to read
// it, click one to fly in: the globe swings that region to the front and the
// nodes there unfold around the hub so you can watch them take jobs.
//
// Everything on it is driven by the live feed. Nothing is placed that is not
// reporting; regions are the coarse metro key a node chose to share.

import type { HardwareTier, LiveEvent, NodeClass, PublicNode, RegionKey } from '@nightshift/shared';
import { REGIONS, TIER_LABEL } from '@nightshift/shared';
import { landPoints } from './land';
import { TIER_COLOR, TIER_ORDER, TIER_SIZE, mix, prng, rgba } from './field';

const INK = '#dfe6ee';
const DIM = '#5a6578';
const BLUE = '#8fa3ff';
const GREEN = '#3df28a';
const RED = '#ff6b6b';

interface GNode {
  id: string;
  cls: NodeClass;
  tier: HardwareTier;
  label: string;
  gpu: string;
  region: RegionKey | null;
  busy: boolean;
  jobs: number;
  hot: number;
  pulse: number;
  heat: number;
  phase: number;
  // screen position while its hub is in focus
  x: number;
  y: number;
}

interface Hub {
  key: RegionKey;
  name: string;
  lat: number;
  lon: number;
  nodes: GNode[];
  pulse: number;
  hot: number;
  // last projection
  sx: number;
  sy: number;
  z: number;
}

interface Packet {
  from: () => [number, number] | null;
  to: () => [number, number] | null;
  t: number;
  dur: number;
  color: string;
  kind: 'job' | 'receipt';
  bend: number;
  onEnd?: () => void;
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

function tierOf(n: PublicNode): HardwareTier {
  return n.capabilities.hardware?.tier ?? (n.class === 'browser' ? 'gpu-8' : 'gpu-16');
}

const D2R = Math.PI / 180;

export class Globe {
  private ctx: CanvasRenderingContext2D;
  private nodes = new Map<string, GNode>();
  private hubs = new Map<RegionKey, Hub>();
  private unplaced: GNode[] = []; // nodes with no region: counted, not pinned
  private land = landPoints();
  private stars: { x: number; y: number; r: number; ph: number }[] = [];
  private packets: Packet[] = [];
  private sparks: Spark[] = [];
  private raf = 0;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private t0 = performance.now();
  private visible = true;
  private reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  private io: IntersectionObserver;
  private ro: ResizeObserver;

  // camera
  private view = { rot: -1.4, tilt: 0.42, zoom: 1 };
  private target = { rot: -1.4, tilt: 0.42, zoom: 1 };
  private spin = 0.0022; // radians per frame while idle
  private drag: { x: number; y: number; moved: boolean } | null = null;
  private vel = 0;
  private idleSince = 0;
  private pointer = { x: 0, y: 0, in: false };
  private satPulse = 0;

  focus: Hub | null = null;
  hoveredHub: Hub | null = null;
  hoveredNode: GNode | null = null;
  private backBtn: [number, number, number, number] | null = null;

  onHover?: (text: string | null) => void;
  onFocus?: (region: { key: RegionKey; name: string; nodes: PublicNode[] } | null) => void;
  onClick?: (nodeId: string) => void;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
    this.io = new IntersectionObserver(([e]) => (this.visible = e.isIntersecting), { threshold: 0.01 });
    this.io.observe(canvas);
    this.resize();
    const rnd = prng(11);
    for (let i = 0; i < 220; i++) this.stars.push({ x: rnd(), y: rnd(), r: 0.3 + rnd() * 1.1, ph: rnd() * 6.283 });

    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      this.drag = { x: e.clientX, y: e.clientY, moved: false };
      this.vel = 0;
    });
    canvas.addEventListener('pointermove', (e) => {
      const r = canvas.getBoundingClientRect();
      this.pointer = { x: e.clientX - r.left, y: e.clientY - r.top, in: true };
      if (this.drag && !this.focus) {
        const dx = e.clientX - this.drag.x;
        const dy = e.clientY - this.drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) this.drag.moved = true;
        const R = this.radius();
        this.target.rot += dx / R;
        this.view.rot = this.target.rot;
        this.target.tilt = clamp(this.target.tilt + dy / R, -1.2, 1.2);
        this.view.tilt = this.target.tilt;
        this.vel = dx / R;
        this.drag.x = e.clientX;
        this.drag.y = e.clientY;
        this.idleSince = performance.now();
      }
    });
    const up = (e: PointerEvent) => {
      const d = this.drag;
      this.drag = null;
      if (!d) return;
      if (d.moved) return;
      // a click
      const r = canvas.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      if (this.backBtn && inRect(x, y, this.backBtn)) return this.unfocus();
      if (this.focus) {
        if (this.hoveredNode) this.onClick?.(this.hoveredNode.id);
        else if (this.hoveredHub && this.hoveredHub !== this.focus) this.focusHub(this.hoveredHub);
        else this.unfocus();
        return;
      }
      if (this.hoveredHub) this.focusHub(this.hoveredHub);
    };
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', () => (this.drag = null));
    canvas.addEventListener('pointerleave', () => (this.pointer.in = false));
    window.addEventListener('keydown', this.onKey);
    document.addEventListener('visibilitychange', () => (this.visible = document.visibilityState === 'visible'));
    this.loop();
  }

  private onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && this.focus) this.unfocus();
  };

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.io.disconnect();
    window.removeEventListener('keydown', this.onKey);
  }

  private resize(): void {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = Math.max(1, r.width);
    this.h = Math.max(1, r.height);
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
  }

  // --- camera ---------------------------------------------------------------

  private radius(): number {
    return Math.min(this.w * 0.36, this.h * 0.42) * this.view.zoom;
  }
  private centre(): [number, number] {
    // when zoomed the hub is at the front centre; nudge it up a little so the
    // unfolded ring has room and the hub isn't under the readout
    return [this.w * 0.5, this.h * (this.focus || this.view.zoom > 1.05 ? 0.5 : 0.52)];
  }

  focusHub(hub: Hub): void {
    this.focus = hub;
    this.target.rot = -hub.lon * D2R;
    this.target.tilt = hub.lat * D2R;
    this.target.zoom = 2.1;
    hub.nodes.forEach((n, i) => this.seat(n, i, hub.nodes.length));
    this.onFocus?.({ key: hub.key, name: hub.name, nodes: hub.nodes.map((n) => this.pubOf(n)).filter((p): p is PublicNode => !!p) });
    this.onHover?.(null);
  }

  unfocus(): void {
    if (!this.focus) return;
    this.focus = null;
    this.target.zoom = 1;
    this.target.tilt = 0.42;
    this.idleSince = performance.now();
    this.onFocus?.(null);
  }

  private pubs = new Map<string, PublicNode>();
  private pubOf(n: GNode): PublicNode | undefined {
    return this.pubs.get(n.id);
  }

  /** Where a node sits around its hub while that hub is in focus. */
  private seat(n: GNode, i: number, total: number): void {
    const a = -Math.PI / 2 + (i / total) * Math.PI * 2 + (total > 1 ? 0 : 0);
    const ring = Math.min(this.w, this.h) * (0.17 + 0.025 * Math.min(total, 8));
    const [cx, cy] = this.centre();
    n.x = cx + Math.cos(a) * ring * 1.35;
    n.y = cy + Math.sin(a) * ring * 0.85;
  }

  // --- state ----------------------------------------------------------------

  apply(ev: LiveEvent): void {
    switch (ev.t) {
      case 'hello':
        this.setNodes(ev.nodes);
        break;
      case 'node.up':
        this.upsert(ev.node);
        break;
      case 'node.down':
        this.remove(ev.nodeId);
        break;
      case 'node.busy': {
        const n = this.nodes.get(ev.nodeId);
        if (n) n.busy = ev.busy;
        break;
      }
      case 'job.queued':
        this.satPulse = 1;
        break;
      case 'job.assigned': {
        const n = this.nodes.get(ev.nodeId);
        if (!n) break;
        n.busy = true;
        n.pulse = 1;
        n.heat = 1;
        const hub = n.region ? this.hubs.get(n.region) : null;
        if (hub) {
          hub.pulse = 1;
          this.packets.push(this.mk(() => this.satPos(), () => this.hubPos(hub), BLUE, 'job', 1100, () => {
            if (this.focus === hub) this.packets.push(this.mk(() => this.hubPos(hub), () => [n.x, n.y], BLUE, 'job', 500));
          }));
        }
        break;
      }
      case 'job.done': {
        const n = this.nodes.get(ev.nodeId);
        if (!n) break;
        n.busy = false;
        n.jobs += 1;
        n.hot = 1;
        n.heat = 1;
        const hub = n.region ? this.hubs.get(n.region) : null;
        if (hub) {
          const back = () => {
            hub.hot = 1;
            hub.pulse = 1;
            this.packets.push(this.mk(() => this.hubPos(hub), () => this.satPos(), GREEN, 'receipt', 1100, () => (this.satPulse = 1)));
          };
          if (this.focus === hub) {
            this.burst(n.x, n.y, GREEN, 12);
            this.packets.push(this.mk(() => [n.x, n.y], () => this.hubPos(hub), GREEN, 'receipt', 500, back));
          } else back();
        }
        break;
      }
      case 'job.failed': {
        const n = ev.nodeId ? this.nodes.get(ev.nodeId) : null;
        if (n) {
          n.busy = false;
          if (this.focus && n.region === this.focus.key) this.burst(n.x, n.y, RED, 6);
        }
        break;
      }
    }
  }

  setNodes(list: PublicNode[]): void {
    const keep = new Set(list.map((n) => n.id));
    for (const id of Array.from(this.nodes.keys())) if (!keep.has(id)) this.remove(id);
    for (const n of list) this.upsert(n);
  }

  private upsert(p: PublicNode): void {
    this.pubs.set(p.id, p);
    const region = p.capabilities.region && REGIONS[p.capabilities.region] ? p.capabilities.region : null;
    const ex = this.nodes.get(p.id);
    if (ex) {
      ex.busy = p.status === 'busy';
      ex.label = p.label;
      ex.jobs = p.jobsDone;
      ex.tier = tierOf(p);
      if (ex.region !== region) {
        this.detach(ex);
        ex.region = region;
        this.attach(ex);
      }
      return;
    }
    const n: GNode = {
      id: p.id, cls: p.class, tier: tierOf(p), label: p.label, gpu: p.capabilities.hardware?.gpu ?? '', region,
      busy: p.status === 'busy', jobs: p.jobsDone, hot: 0, pulse: 1, heat: 0, phase: hash(p.id) * 6.283, x: 0, y: 0,
    };
    this.nodes.set(p.id, n);
    this.attach(n);
  }

  private attach(n: GNode): void {
    if (!n.region) {
      this.unplaced.push(n);
      return;
    }
    let hub = this.hubs.get(n.region);
    if (!hub) {
      const r = REGIONS[n.region];
      hub = { key: n.region, name: r.name, lat: r.lat, lon: r.lon, nodes: [], pulse: 1, hot: 0, sx: 0, sy: 0, z: -1 };
      this.hubs.set(n.region, hub);
    }
    hub.nodes.push(n);
    hub.nodes.sort((a, b) => hash(a.id) - hash(b.id));
    if (this.focus === hub) {
      hub.nodes.forEach((m, i) => this.seat(m, i, hub!.nodes.length));
      this.onFocus?.({ key: hub.key, name: hub.name, nodes: hub.nodes.map((m) => this.pubOf(m)).filter((p): p is PublicNode => !!p) });
    }
  }

  private detach(n: GNode): void {
    this.unplaced = this.unplaced.filter((m) => m !== n);
    if (!n.region) return;
    const hub = this.hubs.get(n.region);
    if (!hub) return;
    hub.nodes = hub.nodes.filter((m) => m !== n);
    if (!hub.nodes.length) {
      this.hubs.delete(n.region);
      if (this.focus === hub) this.unfocus();
    } else if (this.focus === hub) {
      hub.nodes.forEach((m, i) => this.seat(m, i, hub.nodes.length));
    }
  }

  private remove(id: string): void {
    const n = this.nodes.get(id);
    if (!n) return;
    this.detach(n);
    this.nodes.delete(id);
    this.pubs.delete(id);
  }

  private mk(from: Packet['from'], to: Packet['to'], color: string, kind: Packet['kind'], dur: number, onEnd?: () => void): Packet {
    return { from, to, t: 0, dur: this.reduced ? 1 : dur, color, kind, bend: (hash(String(performance.now())) - 0.5) * 0.5, onEnd };
  }

  private burst(x: number, y: number, color: string, count: number): void {
    if (this.reduced) return;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * 6.283 + Math.random() * 0.4;
      const v = 0.8 + Math.random() * 1.6;
      this.sparks.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 1, color });
    }
  }

  // --- projection -----------------------------------------------------------

  /** lat/lon (degrees) → [sx, sy, z]; z > 0 faces the viewer. */
  private project(lat: number, lon: number, R = this.radius(), c = this.centre()): [number, number, number] {
    const φ = lat * D2R;
    const λ = lon * D2R + this.view.rot;
    const x = Math.cos(φ) * Math.sin(λ);
    const y = Math.sin(φ);
    const z = Math.cos(φ) * Math.cos(λ);
    const ct = Math.cos(this.view.tilt);
    const st = Math.sin(this.view.tilt);
    const y2 = y * ct - z * st;
    const z2 = y * st + z * ct;
    return [c[0] + x * R, c[1] - y2 * R, z2];
  }

  private hubPos(hub: Hub): [number, number] | null {
    const [x, y, z] = this.project(hub.lat, hub.lon);
    return z > -0.05 ? [x, y] : null;
  }

  /** The router: a satellite on a tilted orbit, just outside the globe. */
  private sat3(): [number, number, number] {
    const t = ((performance.now() - this.t0) / 1000) * (this.reduced ? 0 : 0.18) + 2.1;
    const R = this.radius() * (this.focus ? 1.08 : 1.32);
    const [cx, cy] = this.centre();
    const incl = 0.55;
    const x = Math.cos(t);
    const y = Math.sin(t) * Math.sin(incl);
    const z = Math.sin(t) * Math.cos(incl);
    return [cx + x * R, cy - y * R * 0.9, z];
  }
  private satPos(): [number, number] | null {
    const [x, y] = this.sat3();
    return [x, y];
  }

  // --- render ---------------------------------------------------------------

  private loop = (): void => {
    this.raf = requestAnimationFrame(this.loop);
    if (!this.visible) return;
    this.draw(performance.now());
  };

  private draw(now: number): void {
    const { ctx, w, h } = this;
    if (w < 40 || h < 40) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const t = (now - this.t0) / 1000;

    // camera easing
    if (!this.drag) {
      if (!this.focus && !this.reduced) {
        // idle spin, resuming gently after a drag
        const idle = Math.min(1, (now - this.idleSince - 1200) / 2000);
        if (idle > 0) this.target.rot += this.spin * idle;
        if (Math.abs(this.vel) > 0.0003) {
          this.target.rot += this.vel;
          this.vel *= 0.94;
        }
      }
      let dr = this.target.rot - this.view.rot;
      dr = Math.atan2(Math.sin(dr), Math.cos(dr));
      const k = this.focus || this.view.zoom > 1.01 ? 0.06 : 0.12;
      this.view.rot += dr * k;
      this.view.tilt += (this.target.tilt - this.view.tilt) * 0.08;
      this.view.zoom += (this.target.zoom - this.view.zoom) * 0.07;
    }
    const R = this.radius();
    const [cx, cy] = this.centre();
    const zoomed = this.view.zoom > 1.05;
    const focusK = clamp((this.view.zoom - 1) / 1.6, 0, 1); // how far into the fly-in we are

    // sky
    const sky = ctx.createRadialGradient(cx, cy, R * 0.5, cx, cy, Math.max(w, h));
    sky.addColorStop(0, '#05070e');
    sky.addColorStop(1, '#010103');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);
    for (const s of this.stars) {
      const tw = this.reduced ? 0.6 : 0.5 + 0.5 * Math.sin(t * 0.8 + s.ph);
      ctx.globalAlpha = 0.15 + tw * 0.45;
      ctx.fillStyle = s.r > 1.1 ? INK : BLUE;
      ctx.fillRect(s.x * w, s.y * h, s.r, s.r);
    }
    ctx.globalAlpha = 1;

    // satellite behind the globe?
    const sat = this.sat3();
    if (sat[2] < 0) this.drawSat(sat, t, 0.35);

    // atmosphere
    const atm = ctx.createRadialGradient(cx, cy, R * 0.92, cx, cy, R * 1.25);
    atm.addColorStop(0, 'rgba(143,163,255,0.22)');
    atm.addColorStop(0.5, 'rgba(143,163,255,0.05)');
    atm.addColorStop(1, 'rgba(143,163,255,0)');
    ctx.fillStyle = atm;
    ctx.beginPath();
    ctx.arc(cx, cy, R * 1.25, 0, 6.283);
    ctx.fill();

    // body: lit from the upper left
    const body = ctx.createRadialGradient(cx - R * 0.35, cy - R * 0.4, R * 0.1, cx, cy, R);
    body.addColorStop(0, '#111a2c');
    body.addColorStop(0.7, '#070b15');
    body.addColorStop(1, '#03040a');
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, 6.283);
    ctx.fill();
    // rim light
    ctx.strokeStyle = 'rgba(143,163,255,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(1, R - 0.5), 0, 6.283);
    ctx.stroke();

    // graticule
    ctx.strokeStyle = 'rgba(143,163,255,0.07)';
    ctx.lineWidth = 1;
    for (let lon = -180; lon < 180; lon += 30) this.polyline(Array.from({ length: 37 }, (_, i) => [-90 + i * 5, lon] as [number, number]));
    for (let lat = -60; lat <= 60; lat += 30) this.polyline(Array.from({ length: 73 }, (_, i) => [lat, -180 + i * 5] as [number, number]));

    // land: dots, brighter toward the viewer and toward the light
    const dot = Math.max(1.1, R / this.view.zoom / 165) * Math.min(1.5, Math.pow(this.view.zoom, 0.45));
    const buckets: [number, number][][] = [[], [], [], []];
    const L = this.land;
    for (let i = 0; i < L.length; i += 2) {
      const [x, y, z] = this.project(L[i], L[i + 1], R, [cx, cy]);
      if (z <= 0) continue;
      const lit = z * (0.75 + 0.25 * ((cx - x) / R + (cy - y) / R) * 0.5);
      buckets[Math.min(3, Math.floor(lit * 4))].push([x, y]);
    }
    const shades = ['rgba(110,130,175,0.20)', 'rgba(135,155,200,0.38)', 'rgba(165,182,222,0.58)', 'rgba(205,216,240,0.82)'];
    buckets.forEach((b, i) => {
      ctx.fillStyle = shades[i];
      for (const [x, y] of b) ctx.fillRect(x - dot / 2, y - dot / 2, dot, dot);
    });

    // terminator-ish shading: darken the right/lower limb
    const shade = ctx.createRadialGradient(cx - R * 0.3, cy - R * 0.3, R * 0.2, cx, cy, R);
    shade.addColorStop(0, 'rgba(0,0,0,0)');
    shade.addColorStop(0.75, 'rgba(0,0,0,0.05)');
    shade.addColorStop(1, 'rgba(0,0,0,0.55)');
    ctx.fillStyle = shade;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, 6.283);
    ctx.fill();

    // hubs
    let hovered: Hub | null = null;
    let bestD = 26;
    for (const hub of this.hubs.values()) {
      const [x, y, z] = this.project(hub.lat, hub.lon, R, [cx, cy]);
      hub.sx = x;
      hub.sy = y;
      hub.z = z;
      if (z <= 0) continue;
      if (this.pointer.in) {
        const d = Math.hypot(x - this.pointer.x, y - this.pointer.y);
        if (d < bestD) {
          bestD = d;
          hovered = hub;
        }
      }
    }
    const sorted = Array.from(this.hubs.values()).filter((hb) => hb.z > 0).sort((a, b) => a.z - b.z);
    for (const hub of sorted) {
      const busy = hub.nodes.filter((n) => n.busy).length;
      const size = (3 + Math.sqrt(hub.nodes.length) * 2.2) * (0.8 + hub.z * 0.2) * (zoomed ? 1.3 : 1);
      const col = hub.hot > 0 ? mix(BLUE, GREEN, hub.hot) : BLUE;
      const isFocus = this.focus === hub;
      // ground glow
      const g = ctx.createRadialGradient(hub.sx, hub.sy, 0, hub.sx, hub.sy, size * 5);
      g.addColorStop(0, rgba(col, isFocus ? 0.55 : 0.4));
      g.addColorStop(0.4, rgba(col, 0.12));
      g.addColorStop(1, rgba(col, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(hub.sx, hub.sy, size * 5, 0, 6.283);
      ctx.fill();
      // pulse ring
      if (hub.pulse > 0) {
        ctx.strokeStyle = col;
        ctx.globalAlpha = hub.pulse * 0.7;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.ellipse(hub.sx, hub.sy, size + (1 - hub.pulse) * 34, (size + (1 - hub.pulse) * 34) * (0.4 + hub.z * 0.6), 0, 0, 6.283);
        ctx.stroke();
        ctx.globalAlpha = 1;
        hub.pulse = Math.max(0, hub.pulse - 0.02);
      }
      // busy ticks orbit the hub
      if (busy && !this.reduced) {
        ctx.strokeStyle = col;
        ctx.globalAlpha = 0.9;
        ctx.lineWidth = 1.5;
        for (let s = 0; s < Math.min(busy, 6); s++) {
          const a0 = t * 2.5 + (s / Math.min(busy, 6)) * 6.283;
          ctx.beginPath();
          ctx.arc(hub.sx, hub.sy, size + 5, a0, a0 + 0.6);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
      // core
      const core = ctx.createRadialGradient(hub.sx - size * 0.3, hub.sy - size * 0.3, 0, hub.sx, hub.sy, size);
      core.addColorStop(0, '#ffffff');
      core.addColorStop(0.5, hovered === hub || isFocus ? '#ffffff' : col);
      core.addColorStop(1, mix(col, '#000000', 0.4));
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.arc(hub.sx, hub.sy, size, 0, 6.283);
      ctx.fill();
      hub.hot = Math.max(0, hub.hot - 0.01);
      // label: always when zoomed or hovered, otherwise for the bigger hubs facing us
      if (!isFocus && (hovered === hub || zoomed || (hub.z > 0.6 && hub.nodes.length >= 3))) {
        ctx.font = `${hovered === hub ? 600 : 400} 11px Inter Tight, system-ui, sans-serif`;
        ctx.fillStyle = hovered === hub ? INK : rgba('#c7d0dc', 0.35 + hub.z * 0.5);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(`${hub.name} · ${hub.nodes.length}`, hub.sx + size + 7, hub.sy);
      }
    }
    if (!this.focus && !this.drag && hovered !== this.hoveredHub) {
      this.hoveredHub = hovered;
      this.canvas.style.cursor = hovered ? 'pointer' : this.drag ? 'grabbing' : 'grab';
      this.onHover?.(hovered ? `${hovered.name} · ${hovered.nodes.length} node${hovered.nodes.length === 1 ? '' : 's'} · ${hovered.nodes.filter((n) => n.busy).length} working · click to fly in` : null);
    } else if (this.focus) this.hoveredHub = hovered;

    // focused region: unfold its nodes around the hub
    if (this.focus) this.drawFocus(this.focus, t, focusK);
    else this.hoveredNode = null;

    // packets (screen-space arcs that bow away from the globe centre)
    for (let i = this.packets.length - 1; i >= 0; i--) {
      const p = this.packets[i];
      p.t += 16.7 / p.dur;
      const k = Math.min(1, p.t);
      const a = p.from();
      const b = p.to();
      if (!a || !b) {
        this.packets.splice(i, 1);
        p.onEnd?.();
        continue;
      }
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      const mx = (a[0] + b[0]) / 2;
      const my = (a[1] + b[1]) / 2;
      // control point pushed outward from the globe centre
      const ox = mx - cx;
      const oy = my - cy;
      const od = Math.hypot(ox, oy) || 1;
      const lift = Math.hypot(b[0] - a[0], b[1] - a[1]) * 0.35;
      const c0: [number, number] = [mx + (ox / od) * lift + (b[1] - a[1]) * p.bend, my + (oy / od) * lift - (b[0] - a[0]) * p.bend];
      const at = (u: number): [number, number] => [(1 - u) * (1 - u) * a[0] + 2 * (1 - u) * u * c0[0] + u * u * b[0], (1 - u) * (1 - u) * a[1] + 2 * (1 - u) * u * c0[1] + u * u * b[1]];
      const [x, y] = at(e);
      // trail: the stretch of curve just behind the head
      const span = 0.22;
      const steps = 14;
      ctx.strokeStyle = p.color;
      ctx.lineCap = 'round';
      let prev = at(Math.max(0, e - span));
      for (let j = 1; j <= steps; j++) {
        const u = Math.max(0, e - span) + (span * j) / steps;
        if (u > e) break;
        const cur = at(u);
        ctx.globalAlpha = (j / steps) * 0.75;
        ctx.lineWidth = (j / steps) * 3;
        ctx.beginPath();
        ctx.moveTo(prev[0], prev[1]);
        ctx.lineTo(cur[0], cur[1]);
        ctx.stroke();
        prev = cur;
      }
      ctx.globalAlpha = 1;
      const g = ctx.createRadialGradient(x, y, 0, x, y, 12);
      g.addColorStop(0, rgba(p.color, 0.7));
      g.addColorStop(1, rgba(p.color, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, 12, 0, 6.283);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      if (p.kind === 'receipt') {
        ctx.fillStyle = p.color;
        ctx.fillRect(x - 3.5, y - 4.5, 7, 9);
        ctx.fillStyle = '#ffffff';
        for (let l = 0; l < 3; l++) ctx.fillRect(x - 2, y - 2.5 + l * 2.2, l === 2 ? 2.5 : 4, 1);
      } else {
        ctx.beginPath();
        ctx.arc(x, y, 2.6, 0, 6.283);
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
      s.x += s.vx;
      s.y += s.vy;
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
      ctx.arc(s.x, s.y, 1.6 * s.life + 0.4, 0, 6.283);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // satellite in front
    if (sat[2] >= 0) this.drawSat(sat, t, 1);

    this.drawHud(t);
  }

  private polyline(pts: [number, number][]): void {
    const { ctx } = this;
    let open = false;
    ctx.beginPath();
    for (const [lat, lon] of pts) {
      const [x, y, z] = this.project(lat, lon);
      if (z > 0) {
        if (!open) {
          ctx.moveTo(x, y);
          open = true;
        } else ctx.lineTo(x, y);
      } else open = false;
    }
    ctx.stroke();
  }

  private drawSat([x, y]: [number, number, number], t: number, alpha: number): void {
    const { ctx } = this;
    ctx.globalAlpha = alpha;
    const halo = ctx.createRadialGradient(x, y, 2, x, y, 26 + this.satPulse * 14);
    halo.addColorStop(0, `rgba(223,230,238,${0.35 + this.satPulse * 0.4})`);
    halo.addColorStop(1, 'rgba(223,230,238,0)');
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(x, y, 26 + this.satPulse * 14, 0, 6.283);
    ctx.fill();
    if (!this.reduced) {
      ctx.strokeStyle = BLUE;
      ctx.lineWidth = 1.2;
      ctx.globalAlpha = alpha * 0.8;
      for (let s = 0; s < 2; s++) {
        const a0 = t * 1.6 + s * Math.PI;
        ctx.beginPath();
        ctx.arc(x, y, 13, a0, a0 + 1.4);
        ctx.stroke();
      }
      ctx.globalAlpha = alpha;
    }
    // body: a small receipt
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = INK;
    ctx.beginPath();
    ctx.roundRect(-6, -7, 12, 14, 2);
    ctx.fill();
    ctx.fillStyle = '#020305';
    for (let l = 0; l < 3; l++) ctx.fillRect(-3.5, -3.5 + l * 3, l === 2 ? 4 : 7, 1.2);
    ctx.restore();
    ctx.font = '600 10px Inter Tight, system-ui, sans-serif';
    ctx.fillStyle = rgba(INK, 0.7 * alpha);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('ROUTER', x, y + 12);
    ctx.globalAlpha = 1;
    this.satPulse = Math.max(0, this.satPulse - 0.03);
  }

  private drawFocus(hub: Hub, t: number, k: number): void {
    const { ctx } = this;
    if (k < 0.2) return;
    const a = (k - 0.2) / 0.8;
    const hx = hub.sx;
    const hy = hub.sy;
    let hov: GNode | null = null;
    let bd = 24;
    // dim the rest of the world a little so the region reads
    ctx.fillStyle = `rgba(2,3,5,${0.35 * a})`;
    ctx.fillRect(0, 0, this.w, this.h);
    hub.nodes.forEach((n, i) => {
      this.seat(n, i, hub.nodes.length);
      // settle in from the hub
      const sx = hx + (n.x - hx) * ease(a);
      const sy = hy + (n.y - hy) * ease(a);
      if (!this.reduced) {
        n.x = sx + Math.sin(t * 0.7 + n.phase) * 3;
        n.y = sy + Math.cos(t * 0.6 + n.phase) * 3;
      } else {
        n.x = sx;
        n.y = sy;
      }
      if (this.pointer.in) {
        const d = Math.hypot(n.x - this.pointer.x, n.y - this.pointer.y);
        if (d < bd) {
          bd = d;
          hov = n;
        }
      }
    });
    if (hov !== this.hoveredNode) {
      this.hoveredNode = hov;
      const hn = hov as GNode | null;
      this.canvas.style.cursor = hn ? 'pointer' : 'default';
      this.onHover?.(hn ? `${hn.label} · ${hn.gpu || TIER_LABEL[hn.tier]} · ${hn.jobs} done · ${hn.busy ? 'working' : 'idle'} · click to pin` : null);
    }
    for (const n of hub.nodes) {
      const col = TIER_COLOR[n.tier];
      const r = TIER_SIZE[n.tier] * 1.6;
      // link to the hub
      ctx.strokeStyle = rgba(col, 0.18 * a);
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(hx, hy);
      ctx.lineTo(n.x, n.y);
      ctx.stroke();
      if (n.heat > 0 || n.busy) {
        ctx.strokeStyle = rgba(col, Math.max(n.heat * 0.8, n.busy ? 0.35 : 0) * a);
        ctx.lineWidth = 1 + n.heat * 1.5;
        if (n.busy && !this.reduced) {
          ctx.setLineDash([3, 8]);
          ctx.lineDashOffset = -t * 60;
        }
        ctx.beginPath();
        ctx.moveTo(hx, hy);
        ctx.lineTo(n.x, n.y);
        ctx.stroke();
        ctx.setLineDash([]);
        n.heat = Math.max(0, n.heat - 0.006);
      }
      // halo
      const lift = n.busy ? 0.55 : n.hot > 0 ? 0.3 + n.hot * 0.5 : n === hov ? 0.6 : 0.22;
      const hr = r * (n.busy ? 4 : 3);
      const g = ctx.createRadialGradient(n.x, n.y, r * 0.4, n.x, n.y, hr);
      g.addColorStop(0, rgba(n.hot > 0 ? GREEN : col, lift * a));
      g.addColorStop(1, rgba(col, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(n.x, n.y, hr, 0, 6.283);
      ctx.fill();
      if (n.pulse > 0) {
        ctx.strokeStyle = col;
        ctx.globalAlpha = n.pulse * 0.6 * a;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(n.x, n.y, r + (1 - n.pulse) * 26, 0, 6.283);
        ctx.stroke();
        ctx.globalAlpha = 1;
        n.pulse = Math.max(0, n.pulse - 0.025);
      }
      if (n.busy && !this.reduced) {
        ctx.strokeStyle = col;
        ctx.globalAlpha = 0.9 * a;
        ctx.lineWidth = 1.5;
        const a0 = t * 4 + n.phase;
        for (let s = 0; s < 3; s++) {
          ctx.beginPath();
          ctx.arc(n.x, n.y, r + 5, a0 + s * 2.094, a0 + s * 2.094 + 1.2);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
      const c = n.hot > 0 ? mix(col, GREEN, n.hot) : col;
      const core = ctx.createRadialGradient(n.x - r * 0.3, n.y - r * 0.3, 0, n.x, n.y, r);
      core.addColorStop(0, '#ffffff');
      core.addColorStop(0.35, n === hov ? '#ffffff' : c);
      core.addColorStop(1, mix(c, '#000000', 0.45));
      ctx.fillStyle = core;
      ctx.globalAlpha = a;
      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, 6.283);
      ctx.fill();
      n.hot = Math.max(0, n.hot - 0.012);
      // label
      ctx.font = `${n === hov ? 600 : 400} 11px Inter Tight, system-ui, sans-serif`;
      ctx.fillStyle = n === hov ? INK : '#8e9aab';
      ctx.textAlign = n.x < hx ? 'right' : 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(n.label.slice(0, 22), n.x + (n.x < hx ? -r - 8 : r + 8), n.y);
      ctx.fillStyle = DIM;
      ctx.font = '10px Inter Tight, system-ui, sans-serif';
      ctx.fillText((n.gpu || TIER_LABEL[n.tier]).slice(0, 26), n.x + (n.x < hx ? -r - 8 : r + 8), n.y + 13);
      ctx.globalAlpha = 1;
    }
    // region title
    ctx.globalAlpha = a;
    ctx.font = '600 15px Inter Tight, system-ui, sans-serif';
    ctx.fillStyle = INK;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(hub.name, hx, hy - 16);
    ctx.font = '11px Inter Tight, system-ui, sans-serif';
    ctx.fillStyle = '#8e9aab';
    ctx.textBaseline = 'top';
    const busy = hub.nodes.filter((n) => n.busy).length;
    ctx.fillText(`${hub.nodes.length} node${hub.nodes.length === 1 ? '' : 's'} · ${busy} working`, hx, hy + 14);
    ctx.globalAlpha = 1;
  }

  private drawHud(t: number): void {
    const { ctx, w, h } = this;
    const real = this.nodes.size;
    ctx.font = '600 10px Inter Tight, system-ui, sans-serif';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillStyle = GREEN;
    ctx.globalAlpha = 0.6 + 0.4 * Math.sin(t * 3);
    ctx.beginPath();
    ctx.arc(20, 21, 3, 0, 6.283);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#8e9aab';
    ctx.fillText(`${real} NODE${real === 1 ? '' : 'S'} · ${this.hubs.size} REGION${this.hubs.size === 1 ? '' : 'S'}${this.unplaced.length ? ` · ${this.unplaced.length} UNPINNED` : ''}`.toUpperCase(), 30, 16);
    ctx.textAlign = 'right';
    if (this.focus) {
      // back pill
      const label = '← ALL REGIONS  ·  ESC';
      const tw = ctx.measureText(label).width + 24;
      const bx = 16;
      this.backBtn = [bx, 38, tw, 22];
      const over = this.pointer.in && inRect(this.pointer.x, this.pointer.y, this.backBtn);
      ctx.fillStyle = over ? 'rgba(143,163,255,0.25)' : 'rgba(8,11,18,0.8)';
      ctx.strokeStyle = 'rgba(143,163,255,0.4)';
      ctx.beginPath();
      ctx.roundRect(bx, 38, tw, 22, 11);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = INK;
      ctx.textAlign = 'left';
      ctx.fillText(label, bx + 12, 44);
      if (over) this.canvas.style.cursor = 'pointer';
    } else {
      this.backBtn = null;
      ctx.fillStyle = '#5a6578';
      ctx.fillText('DRAG TO SPIN · CLICK A REGION TO FLY IN', w - 16, 16);
    }
    // tier legend while focused
    if (this.focus) {
      const present = new Set(this.focus.nodes.map((n) => n.tier));
      const rows = TIER_ORDER.filter((x) => present.has(x));
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.font = '10px Inter Tight, system-ui, sans-serif';
      rows.forEach((tier, i) => {
        const y = h - 16 - (rows.length - 1 - i) * 16;
        ctx.fillStyle = TIER_COLOR[tier];
        ctx.beginPath();
        ctx.arc(w - 150, y, 3.5, 0, 6.283);
        ctx.fill();
        ctx.fillStyle = '#8e9aab';
        ctx.fillText(TIER_LABEL[tier], w - 140, y);
      });
    }
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
function ease(k: number): number {
  return 1 - Math.pow(1 - k, 3);
}
function inRect(x: number, y: number, r: [number, number, number, number]): boolean {
  return x >= r[0] && x <= r[0] + r[2] && y >= r[1] && y <= r[1] + r[3];
}
