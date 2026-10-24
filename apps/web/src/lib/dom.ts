// Small DOM helpers. No framework; the pages are plain functions that
// return elements and clean up after themselves.

export type Child = Node | string | number | null | undefined | false | Child[];

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, unknown> | null = null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = String(v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      else if (k === 'html') el.innerHTML = String(v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}

export function svg(markup: string): SVGSVGElement {
  const t = document.createElement('template');
  t.innerHTML = markup.trim();
  return t.content.firstElementChild as SVGSVGElement;
}

export function append(parent: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(parent, c);
    else parent.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function fmtInt(n: number): string {
  return new Intl.NumberFormat('en-US').format(Math.round(n));
}

export function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

/** Small amounts read better in µcr; anything over a tenth of a credit reads as credits. */
export function fmtCr(micro: number, digits = 4): string {
  if (Math.abs(micro) < 100_000) return `${fmtInt(micro)} µcr`;
  return `${(micro / 1_000_000).toFixed(digits)} cr`;
}

export function timeHM(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** Tween a number into an element. Used for the live counters. */
export function tweenNumber(el: HTMLElement, to: number, fmt: (n: number) => string = fmtInt, ms = 700): void {
  const from = Number(el.dataset.v ?? '0');
  el.dataset.v = String(to);
  if (prefersReducedMotion() || from === to) {
    el.textContent = fmt(to);
    return;
  }
  const t0 = performance.now();
  const tick = (t: number) => {
    const k = Math.min(1, (t - t0) / ms);
    const e = 1 - Math.pow(1 - k, 3);
    el.textContent = fmt(from + (to - from) * e);
    if (k < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

export function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** One reveal pass per page: elements with .reveal fade in as they scroll into view. */
export function mountReveals(root: ParentNode): () => void {
  const els = Array.from(root.querySelectorAll<HTMLElement>('.reveal'));
  if (prefersReducedMotion()) {
    els.forEach((e) => e.classList.add('in'));
    return () => {};
  }
  const io = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (en.isIntersecting) {
          en.target.classList.add('in');
          io.unobserve(en.target);
        }
      }
    },
    { rootMargin: '0px 0px -8% 0px', threshold: 0.05 },
  );
  els.forEach((e) => io.observe(e));
  return () => io.disconnect();
}

export function copyText(text: string): Promise<void> {
  return navigator.clipboard.writeText(text);
}
