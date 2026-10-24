import { marked } from 'marked';
import { h, mountReveals } from '../lib/dom';
import type { Page } from '../main';

// The docs folder at the repo root is the single source. Vite inlines them.
const files = import.meta.glob('../../../../docs/*.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

const ORDER = ['index', 'quickstart', 'api', 'receipts', 'earning', 'run-a-node', 'privacy', 'pricing-and-credits', 'architecture', 'payouts-and-tiers', 'deploy'];

function slugOf(path: string): string {
  return path.split('/').pop()!.replace(/\.md$/, '');
}
function titleOf(md: string, slug: string): string {
  const m = md.match(/^#\s+(.+)$/m);
  return m ? m[1] : slug;
}

const docs = Object.entries(files)
  .map(([p, md]) => ({ slug: slugOf(p), md, title: titleOf(md, slugOf(p)) }))
  .sort((a, b) => ORDER.indexOf(a.slug) - ORDER.indexOf(b.slug));

export function docsPage(slug = 'index'): Page {
  const doc = docs.find((d) => d.slug === slug) ?? docs[0];
  const nav = h('nav', { class: 'docs-nav', 'aria-label': 'Docs' }, docs.map((d) => h('a', { href: `/docs/${d.slug === 'index' ? '' : d.slug}`, 'aria-current': d.slug === doc.slug ? 'page' : undefined }, d.title)));
  const body = h('article', { class: 'prose', html: marked.parse(doc.md, { gfm: true }) as string });
  const el = h('div', { class: 'container section' }, h('div', { class: 'docs' }, nav, body));
  const stopReveal = mountReveals(el);
  return { el, title: doc.title, unmount: stopReveal };
}
