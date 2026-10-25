import './styles/app.css';
import { h, svg, clear, isPreview } from './lib/dom';
import { setNavigate } from './lib/nav';
import { nodeRuntime } from './lib/noderuntime';
import { live } from './lib/live';
import { homePage } from './pages/home';
import { networkPage } from './pages/network';
import { earnPage } from './pages/earn';
import { pricingPage } from './pages/pricing';
import { receiptsPage } from './pages/receipts';
import { docsPage } from './pages/docs';

export interface Page {
  el: HTMLElement;
  title: string;
  unmount?(): void;
}

type Route = { path: RegExp; make: (params: string[]) => Page | Promise<Page> };

const routes: Route[] = [
  { path: /^\/$/, make: () => homePage() },
  { path: /^\/network\/?$/, make: () => networkPage() },
  { path: /^\/earn\/?$/, make: () => earnPage() },
  { path: /^\/pricing\/?$/, make: () => pricingPage() },
  { path: /^\/receipts(?:\/([^/]+))?\/?$/, make: (p) => receiptsPage(p[0]) },
  { path: /^\/docs(?:\/([^/]+))?\/?$/, make: (p) => docsPage(p[0]) },
];

const main = document.getElementById('main')!;
const PREVIEW = isPreview();
/** Where we are. The preview can't own real paths, so it routes on the hash. */
function here(): string {
  if (!PREVIEW) return location.pathname;
  // The preview routes on a bare hash token: "chat", "docs.api", "receipts.rcpt_x".
  const tok = previewRoute || location.hash.slice(1);
  if (!tok) return '/';
  const [head, ...rest] = tok.split('.');
  return '/' + head + (rest.length ? '/' + rest.join('.') : '');
}
let previewRoute = '';
function toToken(path: string): string {
  const parts = path.replace(/^\/|\/$/g, '').split('/');
  return parts.filter(Boolean).join('.');
}
let current: Page | null = null;

const mark = svg(`<svg viewBox="0 0 32 32" aria-hidden="true">
  <rect width="32" height="32" rx="7" fill="#04060a"/>
  <path d="M9 6h14v18l-1.75-1.5L19.5 24l-1.75-1.5L16 24l-1.75-1.5L12.5 24l-1.75-1.5L9 24z" fill="#dfe6ee"/>
  <rect x="12" y="10" width="8" height="1.6" rx=".8" fill="#04060a"/>
  <rect x="12" y="13.5" width="6" height="1.6" rx=".8" fill="#04060a"/>
  <rect x="12" y="17" width="8" height="1.6" rx=".8" fill="#8fa3ff"/>
</svg>`);

// --- theme: system by default, remembered when the person picks one ---
const THEME_KEY = 'nightshift.theme';
function currentTheme(): 'light' | 'dark' {
  const forced = document.documentElement.dataset.theme;
  if (forced === 'light' || forced === 'dark') return forced;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}
function applyTheme(t: 'light' | 'dark' | null): void {
  if (t) document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  try {
    if (t) localStorage.setItem(THEME_KEY, t);
    else localStorage.removeItem(THEME_KEY);
  } catch {
    /* ignore */
  }
  document.dispatchEvent(new CustomEvent('themechange', { detail: currentTheme() }));
}
try {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved;
} catch {
  /* ignore */
}
export { currentTheme };

function topbar(): void {
  const nav = h(
    'nav',
    { class: 'nav', 'aria-label': 'Primary' },
    h('a', { href: '/network' }, 'Network'),
    h('a', { href: '/earn' }, 'Earn'),
    h('a', { href: '/pricing' }, 'Pricing'),
    h('a', { href: '/receipts' }, 'Verify'),
    h('a', { href: '/docs' }, 'Docs'),
  );
  const pulse = h('span', { class: 'pulse', title: 'live feed' }, h('i'), h('span', null, 'connecting'));
  const nodePill = h('a', { class: 'tag stamp node-pill', href: '/earn', hidden: true }, 'node running');
  nodeRuntime.subscribe(() => {
    nodePill.hidden = !nodeRuntime.running;
    nodePill.textContent = nodeRuntime.state === 'working' ? 'node working' : nodeRuntime.state === 'paused' ? 'node paused' : nodeRuntime.state === 'loading' ? 'loading model' : 'node online';
  });
  live.state((up) => {
    pulse.classList.toggle('is-live', up);
    pulse.lastElementChild!.textContent = up ? 'live' : 'reconnecting';
  });
  live.subscribe(() => {});

  const menu = h('button', { class: 'btn secondary icon menu-btn', 'aria-label': 'Menu', onClick: () => nav.classList.toggle('is-open') }, '☰');
  const sun = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  const moon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
  const themeBtn = h('button', { class: 'theme-btn', type: 'button', 'aria-label': 'Toggle night mode', title: 'Night mode' });
  const paint = () => (themeBtn.innerHTML = currentTheme() === 'dark' ? sun : moon);
  themeBtn.addEventListener('click', () => {
    applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');
    paint();
  });
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    paint();
    document.dispatchEvent(new CustomEvent('themechange', { detail: currentTheme() }));
  });
  paint();
  const bar = document.getElementById('topbar')!;
  bar.appendChild(
    h(
      'div',
      { class: 'container' },
      h('a', { class: 'brand', href: '/' }, mark, 'Nightshift'),
      nav,
      h('div', { class: 'topbar-right' }, nodePill, pulse, themeBtn, h('a', { class: 'btn sm', href: '/pricing' }, 'For businesses'), menu),
    ),
  );
  window.addEventListener('scroll', () => bar.classList.toggle('is-scrolled', window.scrollY > 8), { passive: true });

  document.getElementById('footer')!.appendChild(
    h(
      'div',
      { class: 'container' },
      h('span', null, 'Nightshift. Credits are a unit of account on this router, not a currency. Nothing here promises a yield.'),
      h(
        'nav',
        null,
        h('a', { href: '/docs' }, 'Docs'),
        h('a', { href: '/docs/api' }, 'API'),
        h('a', { href: '/docs/earning' }, 'Earning'),
        h('a', { href: '/docs/run-a-node' }, 'Run a node'),
        h('a', { href: '/receipts' }, 'Verify a receipt'),
      ),
    ),
  );
}

async function render(pathname: string): Promise<void> {
  const route = routes.find((r) => r.path.test(pathname));
  const params = route ? (pathname.match(route.path)?.slice(1) ?? []) : [];
  const page = route
    ? await route.make(params.map((p) => (p ? decodeURIComponent(p) : p)))
    : { el: h('div', { class: 'container section' }, h('h1', null, 'Not found'), h('p', { class: 'muted' }, 'That page does not exist.')), title: 'Not found' };

  // Crossfade between pages where the browser supports it; otherwise a short enter animation.
  const swap = () => {
    current?.unmount?.();
    clear(main);
    current = page;
    page.el.classList.add('page');
    main.appendChild(page.el);
  };
  const vt = (document as Document & { startViewTransition?: (cb: () => void) => { finished: Promise<void> } }).startViewTransition;
  if (vt && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) await vt.call(document, swap).finished.catch(() => {});
  else swap();
  document.title = page.title === 'Nightshift' ? 'Nightshift' : `${page.title} — Nightshift`;
  for (const a of document.querySelectorAll<HTMLAnchorElement>('.nav a')) {
    const on = a.getAttribute('href') === '/' ? pathname === '/' : pathname.startsWith(a.getAttribute('href')!);
    if (on) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  document.querySelector('.nav')?.classList.remove('is-open');
  if (PREVIEW || !location.hash) window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
}

function navigate(to: string, replace = false): void {
  if (PREVIEW) {
    previewRoute = toToken(to);
    try {
      if (replace) history.replaceState(null, '', '#' + previewRoute);
      else history.pushState(null, '', '#' + previewRoute);
    } catch {
      /* the viewer may not let us touch the URL; the route is kept in memory anyway */
    }
    void render(here());
    return;
  }
  if (replace) history.replaceState(null, '', to);
  else history.pushState(null, '', to);
  void render(here());
}

document.addEventListener('click', (e) => {
  const a = (e.target as Element).closest('a');
  if (!a || a.target === '_blank' || a.hasAttribute('download') || e.metaKey || e.ctrlKey) return;
  const href = a.getAttribute('href');
  if (!href || !href.startsWith('/') || href.startsWith('//')) return;
  e.preventDefault();
  navigate(href);
});
window.addEventListener('popstate', () => void render(here()));
if (PREVIEW) window.addEventListener('hashchange', () => { previewRoute = location.hash.slice(1); void render(here()); });

topbar();
if (PREVIEW) {
  document.body.classList.add('is-preview');
  document.body.prepend(
    h(
      'div',
      { class: 'preview-banner' },
      h('b', null, 'Preview build.'),
      ' The router and every node on the map are simulated inside this page: routing, holds, refunds and signed receipts are real code; the nodes and their model replies are stand-ins. The repo runs the real thing.',
    ),
  );
}
void render(here());

setNavigate((to) => navigate(to));
