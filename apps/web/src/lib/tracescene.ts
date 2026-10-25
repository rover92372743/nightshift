// The "follow one call" figure: one request drawn as a small living scene.
// Your app on the left, the router in the middle, a cluster of machines on
// the right, the ledger below, and the receipt that gets written as the call
// completes. setStep(i) decides what is lit and what is moving; the loop does
// the rest.

import { TIER_COLOR, TIER_SIZE, mix, prng, rgba } from './field';
import type { HardwareTier } from '@nightshift/shared';

const INK = '#dfe6ee';
const DIM = '#5a6578';
const BLUE = '#8fa3ff';
const GREEN = '#3df28a';
const PAPER = '#f2f5f9';

interface TNode {
  x: number; // 0..1 within the cluster box
  y: number;
  tier: HardwareTier;
  busy: boolean;
  serves: boolean;
  price: number;
  phase: number;
  lit: number; // 0..1 eased highlight
  dimmed: number; // 0..1 eased dimming
}

interface Packet {
  from: () => [number, number];
  to: () => [number, number];
  color: string;
  kind: 'job' | 'receipt';
  dur: number;
  t: number;
  bend: number;
}

const TIERS: HardwareTier[] = ['gpu-8', 'gpu-16', 'gpu-8', 'gpu-24', 'cpu', 'gpu-16', 'gpu-48', 'gpu-8', 'gpu-16', 'gpu-24', 'gpu-8', 'cpu', 'gpu-80', 'gpu-16'];

export class TraceScene {
  private ctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private raf = 0;
  private t0 = performance.now();
  private step = -1;
  private since = 0; // when the step changed
  private nodes: TNode[] = [];
  private chosen: TNode;
  private packets: Packet[] = [];
  private spawnAt = 0;
  private visible = true;
  private reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  private ro: ResizeObserver;
  private io: IntersectionObserver;
  // eased scalars
  private receiptIn = 0;
  private sig1 = 0;
  private sig2 = 0;
  private hold = 0;
  private settle = 0;
  private progress = 0;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    const rnd = prng(23);
    // a loose, organic cluster; the fifth node is the one that wins
    for (let i = 0; i < TIERS.length; i++) {
      const col = i % 4;
      const row = Math.floor(i / 4);
      this.nodes.push({
        x: (col + 0.5) / 4 + (rnd() - 0.5) * 0.16,
        y: (row + 0.5) / 4 + (rnd() - 0.5) * 0.16,
        tier: TIERS[i],
        busy: i === 3 || i === 9,
        serves: i !== 4 && i !== 11 && i !== 6,
        price: 0.23 + rnd() * 0.9,
        phase: rnd() * 6.283,
        lit: 0,
        dimmed: 0,
      });
    }
    this.nodes[12].price = 1.9; // the big card asks more
    this.chosen = this.nodes[5];
    this.chosen.price = 0.23;
    this.chosen.serves = true;
    this.chosen.busy = false;
    for (const n of this.nodes) if (n !== this.chosen && n.serves && !n.busy && n.price < 0.3) n.price += 0.2;
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
    this.io = new IntersectionObserver(([e]) => (this.visible = e.isIntersecting), { threshold: 0.01 });
    this.io.observe(canvas);
    this.resize();
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
  }

  setStep(i: number): void {
    if (i === this.step) return;
    this.step = i;
    this.since = performance.now();
    this.packets = [];
    this.spawnAt = 0;
    if (i < 5) this.receiptIn = 0;
    if (i < 5) this.sig1 = 0;
    if (i < 6) this.sig2 = 0;
    if (i < 1) this.hold = 0;
    if (i < 7) this.settle = 0;
    if (i !== 4) this.progress = 0;
  }

  // --- geometry --------------------------------------------------------------
  private app(): [number, number, number, number] {
    return [this.w * 0.05, this.h * 0.40, this.w * 0.19, this.h * 0.2];
  }
  private appPort(): [number, number] {
    const [x, y, w, h] = this.app();
    return [x + w, y + h / 2];
  }
  private router(): [number, number] {
    return [this.w * 0.45, this.h * 0.5];
  }
  private ledger(): [number, number, number, number] {
    return [this.w * 0.37, this.h * 0.78, this.w * 0.16, this.h * 0.14];
  }
  private cluster(): [number, number, number, number] {
    return [this.w * 0.64, this.h * 0.08, this.w * 0.32, this.h * 0.52];
  }
  private nodePos(n: TNode): [number, number] {
    const [x, y, w, h] = this.cluster();
    return [x + n.x * w, y + n.y * h];
  }
  private receipt(): [number, number, number, number] {
    const rw = Math.min(this.w * 0.16, 120);
    return [this.w * 0.70, this.h * 0.66, rw, rw * 1.25];
  }
  private receiptPort(): [number, number] {
    const [x, y, w] = this.receipt();
    return [x, y + w * 0.5];
  }

  private mk(from: Packet['from'], to: Packet['to'], color: string, kind: Packet['kind'], dur: number, bend = 0.18): Packet {
    return { from, to, color, kind, dur: this.reduced ? 1 : dur, t: 0, bend };
  }

  // --- render -----------------------------------------------------------------------
  private loop = (): void => {
    this.raf = requestAnimationFrame(this.loop);
    if (!this.visible || this.w < 40) return;
    this.draw(performance.now());
  };

  private draw(now: number): void {
    const { ctx, w, h } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const t = (now - this.t0) / 1000;
    const s = this.step;
    const age = (now - this.since) / 1000;
    const ease = (k: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, k)), 3);
    const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

    // bg
    const sky = ctx.createRadialGradient(w * 0.45, h * 0.5, 0, w * 0.45, h * 0.5, Math.max(w, h) * 0.8);
    sky.addColorStop(0, '#080c16');
    sky.addColorStop(1, '#020305');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);
    // faint grid
    ctx.strokeStyle = 'rgba(143,163,255,0.05)';
    ctx.lineWidth = 1;
    const g = 28;
    for (let x = (w / 2) % g; x < w; x += g) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    for (let y = (h / 2) % g; y < h; y += g) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    // scalars for this step
    const target = {
      receipt: s >= 5 ? 1 : 0,
      sig1: s >= 5 ? 1 : 0,
      sig2: s >= 6 ? 1 : 0,
      hold: s >= 1 && s < 7 ? 1 : 0,
      settle: s === 7 ? 1 : 0,
    };
    const k = this.reduced ? 1 : 0.06;
    this.receiptIn = lerp(this.receiptIn, target.receipt, k);
    this.sig1 = lerp(this.sig1, target.sig1, k * 0.8);
    this.sig2 = lerp(this.sig2, target.sig2, k * 0.8);
    this.hold = lerp(this.hold, target.hold, k);
    this.settle = lerp(this.settle, target.settle, k * 0.7);
    if (s === 4) this.progress = this.reduced ? 1 : (age % 3.2) / 3.2;

    const [rx, ry] = this.router();
    const [ax, ay] = this.appPort();
    const [cx, cy] = this.nodePos(this.chosen);
    const [lx, ly, lw] = this.ledger();
    const lport: [number, number] = [lx + lw / 2, ly];

    // wires
    const wire = (a: [number, number], b: [number, number], on: boolean, color = BLUE, bend = 0.18) => {
      const mx = (a[0] + b[0]) / 2 - (b[1] - a[1]) * bend;
      const my = (a[1] + b[1]) / 2 + (b[0] - a[0]) * bend;
      ctx.strokeStyle = on ? rgba(color, 0.55) : 'rgba(143,163,255,0.12)';
      ctx.lineWidth = on ? 1.5 : 1;
      ctx.setLineDash(on && !this.reduced ? [4, 8] : []);
      ctx.lineDashOffset = -t * 50;
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.quadraticCurveTo(mx, my, b[0], b[1]);
      ctx.stroke();
      ctx.setLineDash([]);
    };
    wire([ax, ay], [rx - 30, ry], s === 0 || s === 7, s === 7 ? GREEN : BLUE, 0);
    wire([rx, ry + 30], lport, s === 1 || s === 7, s === 7 ? GREEN : BLUE, 0);
    wire([rx + 30, ry], [cx, cy], s >= 2 && s <= 6, s === 6 ? GREEN : BLUE, 0.12);
    if (s >= 5) {
      ctx.globalAlpha = this.receiptIn;
      wire([cx, cy], this.receiptPort(), s === 5, BLUE, -0.1);
      ctx.globalAlpha = 1;
    }

    // --- your app -----------------------------------------------------------------
    {
      const [x, y, bw, bh] = this.app();
      const on = s === 0 || s === 7;
      ctx.fillStyle = '#0b1020';
      ctx.strokeStyle = on ? rgba(s === 7 ? GREEN : BLUE, 0.9) : 'rgba(143,163,255,0.25)';
      ctx.lineWidth = on ? 1.5 : 1;
      ctx.beginPath();
      ctx.roundRect(x, y, bw, bh, 10);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#9aa7b8';
      ctx.font = '600 11px Inter Tight, system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText('your app', x + 12, y + 10);
      ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillStyle = INK;
      ctx.fillText('POST /v1/chat/', x + 12, y + bh * 0.48);
      ctx.fillText('completions', x + 12, y + bh * 0.48 + 14);
      if (s === 7) {
        ctx.fillStyle = GREEN;
        ctx.fillText('200 · receipt', x + 12, y + bh * 0.48 + 28);
      } else if (s > 0) {
        ctx.fillStyle = DIM;
        ctx.fillText('waiting…', x + 12, y + bh * 0.48 + 28);
      } else if (!this.reduced && Math.floor(t * 2) % 2 === 0) {
        ctx.fillStyle = BLUE;
        ctx.fillRect(x + 12 + 76, y + bh * 0.48 + 15, 6, 11);
      }
    }

    // --- cluster ---------------------------------------------------------------------
    {
      const [x, y, bw] = this.cluster();
      ctx.fillStyle = DIM;
      ctx.font = '600 10px Inter Tight, system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillText('MACHINES ONLINE', x, y - 6);
      void bw;
      for (const n of this.nodes) {
        const [nx, ny] = this.nodePos(n);
        const cand = n.serves && !n.busy;
        const wantLit = s === 2 ? cand : s >= 3 && s <= 6 ? n === this.chosen : false;
        const wantDim = s === 2 ? !cand : s >= 3 && s <= 6 ? n !== this.chosen : false;
        n.lit = lerp(n.lit, wantLit ? 1 : 0, k * 1.5);
        n.dimmed = lerp(n.dimmed, wantDim ? 1 : 0, k * 1.5);
        const col = TIER_COLOR[n.tier];
        const r = TIER_SIZE[n.tier] * 0.9;
        const alpha = 1 - n.dimmed * 0.7;
        const dx = this.reduced ? 0 : Math.sin(t * 0.7 + n.phase) * 2;
        const dy = this.reduced ? 0 : Math.cos(t * 0.6 + n.phase) * 2;
        const px = nx + dx;
        const py = ny + dy;
        // halo
        const hr = r * (2.6 + n.lit * 1.6);
        const hg = ctx.createRadialGradient(px, py, r * 0.3, px, py, hr);
        hg.addColorStop(0, rgba(col, (0.18 + n.lit * 0.5) * alpha));
        hg.addColorStop(1, rgba(col, 0));
        ctx.fillStyle = hg;
        ctx.beginPath();
        ctx.arc(px, py, hr, 0, 6.283);
        ctx.fill();
        // busy spinner (the two busy nodes, and the chosen one while it works)
        if ((n.busy || (n === this.chosen && s === 4)) && !this.reduced) {
          ctx.strokeStyle = rgba(col, 0.9 * alpha);
          ctx.lineWidth = 1.4;
          const a0 = t * 4 + n.phase;
          for (let q = 0; q < 3; q++) {
            ctx.beginPath();
            ctx.arc(px, py, r + 4, a0 + q * 2.094, a0 + q * 2.094 + 1.2);
            ctx.stroke();
          }
        }
        // progress ring while the job runs
        if (n === this.chosen && s === 4) {
          ctx.strokeStyle = rgba(GREEN, 0.9);
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(px, py, r + 9, -Math.PI / 2, -Math.PI / 2 + this.progress * 6.283);
          ctx.stroke();
        }
        // core
        const core = ctx.createRadialGradient(px - r * 0.3, py - r * 0.3, 0, px, py, r);
        core.addColorStop(0, '#ffffff');
        core.addColorStop(0.35, n.lit > 0.5 && n === this.chosen ? '#ffffff' : col);
        core.addColorStop(1, mix(col, '#000000', 0.45));
        ctx.globalAlpha = alpha;
        ctx.fillStyle = core;
        ctx.beginPath();
        ctx.arc(px, py, r, 0, 6.283);
        ctx.fill();
        ctx.globalAlpha = 1;
        // price tags while ranking
        if (s === 2 && cand) {
          ctx.globalAlpha = n.lit;
          ctx.font = `${n === this.chosen ? 600 : 400} 10px ui-monospace, Menlo, monospace`;
          ctx.fillStyle = n === this.chosen ? INK : '#9aa7b8';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          ctx.fillText(`$${n.price.toFixed(2)}`, px, py + r + 4);
          ctx.globalAlpha = 1;
          if (n === this.chosen) {
            ctx.strokeStyle = rgba(INK, 0.8 * n.lit);
            ctx.lineWidth = 1.2;
            ctx.beginPath();
            ctx.arc(px, py, r + 6 + Math.sin(t * 3) * 1.5, 0, 6.283);
            ctx.stroke();
          }
        }
        if (n.busy && s === 2) {
          ctx.globalAlpha = 0.6;
          ctx.font = '10px Inter Tight, system-ui, sans-serif';
          ctx.fillStyle = DIM;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          ctx.fillText('busy', px, py + r + 4);
          ctx.globalAlpha = 1;
        }
      }
      if (s >= 3 && s <= 6) {
        ctx.font = '600 11px Inter Tight, system-ui, sans-serif';
        ctx.fillStyle = INK;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText('steady-maple-365', cx, cy + 16);
        ctx.font = '10px Inter Tight, system-ui, sans-serif';
        ctx.fillStyle = '#9aa7b8';
        ctx.fillText(s === 4 ? 'running · 14 tok/s' : s === 3 ? 'lease 90 s' : s === 5 ? 'signing' : 'signed', cx, cy + 30);
      }
    }

    // --- ledger ------------------------------------------------------------------------
    {
      const [x, y, bw, bh] = this.ledger();
      const on = s === 1 || s === 7;
      ctx.fillStyle = '#0b1020';
      ctx.strokeStyle = on ? rgba(s === 7 ? GREEN : BLUE, 0.9) : 'rgba(143,163,255,0.25)';
      ctx.lineWidth = on ? 1.5 : 1;
      ctx.beginPath();
      ctx.roundRect(x, y, bw, bh, 10);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#9aa7b8';
      ctx.font = '600 11px Inter Tight, system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText('ledger', x + 12, y + 9);
      // three bars: balance, hold, paid to node
      const bx = x + 12;
      const by = y + bh - 12;
      const full = bw - 24;
      const bal = 1 - this.hold * 0.18 - this.settle * 0.02;
      ctx.fillStyle = 'rgba(143,163,255,0.18)';
      ctx.fillRect(bx, by - 6, full, 6);
      ctx.fillStyle = BLUE;
      ctx.fillRect(bx, by - 6, full * bal, 6);
      if (this.hold > 0.02) {
        ctx.fillStyle = s === 7 ? rgba(BLUE, 0.35) : rgba(INK, 0.9);
        ctx.fillRect(bx + full * bal, by - 6, full * 0.18 * this.hold * (1 - this.settle * 0.75), 6);
      }
      if (this.settle > 0.02) {
        ctx.fillStyle = GREEN;
        ctx.fillRect(bx + full * (1 - 0.18 * 0.25) , by - 6, full * 0.18 * 0.25 * this.settle, 6);
      }
      ctx.font = '10px ui-monospace, Menlo, monospace';
      ctx.fillStyle = '#9aa7b8';
      ctx.textBaseline = 'bottom';
      ctx.fillText(s === 7 ? 'charged · refunded · node paid' : this.hold > 0.5 ? 'balance · hold' : 'balance', bx, by - 10);
    }

    // --- receipt ------------------------------------------------------------------------
    if (this.receiptIn > 0.01) {
      const [x, y0, rw, rh] = this.receipt();
      const y = y0 + (1 - ease(this.receiptIn)) * 24;
      ctx.globalAlpha = ease(this.receiptIn);
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.6)';
      ctx.shadowBlur = 18;
      ctx.shadowOffsetY = 8;
      ctx.fillStyle = PAPER;
      ctx.beginPath();
      ctx.moveTo(x, y + 6);
      ctx.quadraticCurveTo(x, y, x + 6, y);
      ctx.lineTo(x + rw - 6, y);
      ctx.quadraticCurveTo(x + rw, y, x + rw, y + 6);
      ctx.lineTo(x + rw, y + rh);
      const teeth = 9;
      for (let i = 0; i <= teeth; i++) ctx.lineTo(x + rw - (rw / teeth) * i, y + rh - (i % 2 ? 5 : 0));
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      ctx.globalAlpha = ease(this.receiptIn);
      ctx.fillStyle = '#11161b';
      ctx.font = '600 9px ui-monospace, Menlo, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText('RECEIPT', x + 10, y + 10);
      ctx.font = '8px ui-monospace, Menlo, monospace';
      ctx.fillStyle = '#4b5967';
      const rows = ['job   job_7f3a…', 'node  nd_19c4…', 'in    sha256 e1…', 'out   sha256 8b…', 'units 41 · $0.000010'];
      rows.forEach((r, i) => ctx.fillText(r, x + 10, y + 24 + i * 11));
      // signatures
      const sy = y + 24 + rows.length * 11 + 4;
      ctx.fillStyle = BLUE;
      ctx.fillRect(x + 10, sy, (rw - 20) * ease(this.sig1), 3);
      ctx.fillStyle = '#4b5967';
      if (this.sig1 > 0.95) ctx.fillText('node sig', x + 10, sy + 5);
      ctx.fillStyle = GREEN;
      ctx.fillRect(x + 10, sy + 16, (rw - 20) * ease(this.sig2), 3);
      ctx.fillStyle = '#4b5967';
      if (this.sig2 > 0.95) ctx.fillText('router sig', x + 10, sy + 21);
      ctx.globalAlpha = 1;
    }

    // --- packets ---------------------------------------------------------------------
    if (!this.reduced && now > this.spawnAt) {
      const every = 1400;
      this.spawnAt = now + every;
      const rP: [number, number] = [rx, ry];
      switch (s) {
        case 0:
          this.packets.push(this.mk(() => [ax, ay], () => [rx - 26, ry], BLUE, 'job', 1100, 0));
          break;
        case 1:
          this.packets.push(this.mk(() => rP, () => lport, BLUE, 'job', 800, 0));
          break;
        case 3:
          this.packets.push(this.mk(() => [rx + 26, ry], () => [cx, cy], BLUE, 'job', 1100, 0.12));
          break;
        case 5:
          this.packets.push(this.mk(() => [cx, cy], () => this.receiptPort(), BLUE, 'job', 800, -0.1));
          break;
        case 6:
          this.packets.push(this.mk(() => [cx, cy], () => [rx + 26, ry], GREEN, 'receipt', 1100, -0.12));
          break;
        case 7:
          this.packets.push(this.mk(() => [rx - 26, ry], () => [ax, ay], GREEN, 'receipt', 1100, 0));
          this.packets.push(this.mk(() => rP, () => lport, GREEN, 'job', 800, 0));
          break;
      }
    }
    for (let i = this.packets.length - 1; i >= 0; i--) {
      const p = this.packets[i];
      p.t += 16.7 / p.dur;
      const kk = Math.min(1, p.t);
      const e = kk < 0.5 ? 2 * kk * kk : 1 - Math.pow(-2 * kk + 2, 2) / 2;
      const a = p.from();
      const b = p.to();
      const mx = (a[0] + b[0]) / 2 - (b[1] - a[1]) * p.bend;
      const my = (a[1] + b[1]) / 2 + (b[0] - a[0]) * p.bend;
      const at = (u: number): [number, number] => [(1 - u) * (1 - u) * a[0] + 2 * (1 - u) * u * mx + u * u * b[0], (1 - u) * (1 - u) * a[1] + 2 * (1 - u) * u * my + u * u * b[1]];
      const [x, y] = at(e);
      ctx.strokeStyle = p.color;
      ctx.lineCap = 'round';
      let prev = at(Math.max(0, e - 0.25));
      for (let j = 1; j <= 12; j++) {
        const u = Math.max(0, e - 0.25) + (0.25 * j) / 12;
        if (u > e) break;
        const cur = at(u);
        ctx.globalAlpha = (j / 12) * 0.8;
        ctx.lineWidth = (j / 12) * 3;
        ctx.beginPath();
        ctx.moveTo(prev[0], prev[1]);
        ctx.lineTo(cur[0], cur[1]);
        ctx.stroke();
        prev = cur;
      }
      ctx.globalAlpha = 1;
      const gl = ctx.createRadialGradient(x, y, 0, x, y, 12);
      gl.addColorStop(0, rgba(p.color, 0.7));
      gl.addColorStop(1, rgba(p.color, 0));
      ctx.fillStyle = gl;
      ctx.beginPath();
      ctx.arc(x, y, 12, 0, 6.283);
      ctx.fill();
      if (p.kind === 'receipt') {
        ctx.fillStyle = p.color;
        ctx.fillRect(x - 3.5, y - 4.5, 7, 9);
        ctx.fillStyle = '#fff';
        for (let l = 0; l < 3; l++) ctx.fillRect(x - 2, y - 2.5 + l * 2.2, l === 2 ? 2.5 : 4, 1);
      } else {
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(x, y, 2.6, 0, 6.283);
        ctx.fill();
      }
      if (kk >= 1) this.packets.splice(i, 1);
    }

    // --- router (drawn last so packets slip under it) -----------------------------------
    {
      const rs = 24;
      const on = s === 1 || s === 2 || s === 3 || s === 6 || s === 7;
      const halo = ctx.createRadialGradient(rx, ry, rs * 0.5, rx, ry, rs * 3.4);
      halo.addColorStop(0, rgba(s === 6 || s === 7 ? GREEN : BLUE, on ? 0.35 : 0.14));
      halo.addColorStop(1, 'rgba(143,163,255,0)');
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(rx, ry, rs * 3.4, 0, 6.283);
      ctx.fill();
      if (!this.reduced) {
        ctx.strokeStyle = s === 6 || s === 7 ? GREEN : BLUE;
        ctx.lineWidth = 1.4;
        ctx.globalAlpha = on ? 0.8 : 0.3;
        for (let q = 0; q < 2; q++) {
          const a0 = t * (on ? 1.4 : 0.5) + q * Math.PI;
          ctx.beginPath();
          ctx.arc(rx, ry, rs * 1.6, a0, a0 + 1.5);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
      const body = ctx.createLinearGradient(rx - rs, ry - rs, rx + rs, ry + rs);
      body.addColorStop(0, '#ffffff');
      body.addColorStop(1, '#aab6c6');
      ctx.fillStyle = body;
      ctx.beginPath();
      ctx.roundRect(rx - rs, ry - rs, rs * 2, rs * 2, 8);
      ctx.fill();
      ctx.fillStyle = '#020305';
      const gw = rs * 0.9;
      const gh = rs * 1.15;
      ctx.beginPath();
      ctx.moveTo(rx - gw / 2, ry - gh / 2);
      ctx.lineTo(rx + gw / 2, ry - gh / 2);
      ctx.lineTo(rx + gw / 2, ry + gh / 2);
      for (let i = 0; i < 6; i++) ctx.lineTo(rx + gw / 2 - (gw / 6) * (i + 0.5), ry + gh / 2 - (i % 2 ? 0 : 3));
      ctx.lineTo(rx - gw / 2, ry + gh / 2);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#dfe6ee';
      for (let i = 0; i < 3; i++) ctx.fillRect(rx - gw * 0.3, ry - gh * 0.3 + i * gh * 0.22, gw * (i === 2 ? 0.4 : 0.6), 2);
      ctx.font = '600 11px Inter Tight, system-ui, sans-serif';
      ctx.fillStyle = INK;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText('router', rx, ry + rs + 8);
      const subs = ['hash input', 'quote · hold credits', 'rank candidates by price', 'assign · lease 90 s', 'waiting', 'waiting', 'verify · countersign', 'charge · refund · pay'];
      ctx.font = '10px ui-monospace, Menlo, monospace';
      ctx.fillStyle = s === 6 || s === 7 ? GREEN : BLUE;
      ctx.fillText(subs[Math.max(0, s)] ?? '', rx, ry + rs + 23);
    }
  }
}
