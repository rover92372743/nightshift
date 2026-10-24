import type { Receipt } from '@docket/shared';
import { h, clear, mountReveals, copyText } from '../lib/dom';
import { api } from '../lib/api';
import { verifyReceiptLocally } from '../lib/keys';
import { receiptEl } from '../lib/receipt';
import type { Page } from '../main';

export function receiptsPage(initialId?: string): Page {
  const idInput = h('input', { class: 'input mono', placeholder: 'rcpt_… or job_…', value: initialId ?? '' }) as HTMLInputElement;
  const lookup = h('button', { class: 'btn' }, 'Look up') as HTMLButtonElement;
  const paste = h('textarea', { class: 'textarea mono', rows: 8, placeholder: 'Or paste a full receipt as JSON' }) as HTMLTextAreaElement;
  const check = h('button', { class: 'btn secondary' }, 'Check pasted receipt') as HTMLButtonElement;
  const out = h('div', { class: 'grid-2', style: { marginTop: '24px', alignItems: 'start' } });

  let routerKey = '';
  api.health().then((hh) => (routerKey = hh.routerKey)).catch(() => {});

  function render(r: Receipt): void {
    clear(out);
    const v = verifyReceiptLocally(r, routerKey || undefined);
    const row = (ok: boolean | null, text: string) =>
      h('div', { class: `check ${ok === null ? '' : ok ? 'ok' : 'bad'}` }, h('i', null, ok === null ? '?' : ok ? '✓' : '✕'), h('span', null, text));
    const verdict = h(
      'div',
      { class: 'verdict' },
      row(v.nodeSignature, v.nodeSignature ? 'The node’s signature matches the receipt body.' : 'The node’s signature does not match. Something in the body was changed, or the key is wrong.'),
      row(v.routerSignature, v.routerSignature ? 'The router’s countersignature matches.' : 'The router’s countersignature does not match.'),
      row(v.routerIsThisRouter, v.routerIsThisRouter === null ? 'Could not compare the router key (router unreachable).' : v.routerIsThisRouter ? 'Signed by this router.' : 'Signed by a different router than this one.'),
    );
    const rc = receiptEl(r, { verified: v.valid });
    const json = JSON.stringify(r, null, 2);
    out.append(
      h('div', { class: 'printer' }, h('div', { class: 'paper' }, rc)),
      h(
        'div',
        { style: { display: 'grid', gap: '16px' } },
        h('div', { class: 'card' }, h('h3', { style: { marginBottom: '12px' } }, v.valid ? 'This receipt checks out' : 'This receipt does not check out'), verdict, h('p', { class: 'small muted', style: { marginTop: '12px' } }, 'Checked in your browser with ed25519 over the canonical body. The router was only asked for its public key.')),
        h('div', { class: 'card' }, h('div', { class: 'row', style: { justifyContent: 'space-between', marginBottom: '10px' } }, h('h3', null, 'Raw'), h('button', { class: 'btn sm secondary', onClick: () => copyText(json) }, 'Copy JSON')), h('pre', null, h('code', null, json))),
      ),
    );
    rc.classList.add('is-static');
  }

  function fail(msg: string): void {
    clear(out);
    out.appendChild(h('div', { class: 'notice bad', style: { gridColumn: '1 / -1' } }, msg));
  }

  async function doLookup(): Promise<void> {
    const id = idInput.value.trim();
    if (!id) return;
    history.replaceState(null, '', `/receipts/${encodeURIComponent(id)}`);
    lookup.disabled = true;
    try {
      const { receipt } = await api.receipt(id);
      render(receipt);
    } catch {
      fail('No receipt with that id on this router.');
    } finally {
      lookup.disabled = false;
    }
  }

  lookup.addEventListener('click', () => void doLookup());
  idInput.addEventListener('keydown', (e) => e.key === 'Enter' && void doLookup());
  check.addEventListener('click', () => {
    try {
      const parsed = JSON.parse(paste.value);
      const r: Receipt = parsed.receipt ?? parsed;
      if (!r.body || !r.nodeSig) throw new Error();
      render(r);
    } catch {
      fail('That is not a receipt. Paste the JSON exactly as the API returned it.');
    }
  });

  const el = h(
    'div',
    { class: 'container section' },
    h('div', { class: 'section-head reveal' }, h('h1', null, 'Verify a receipt'), h('p', null, 'A receipt stands on its own. Paste one here and it is checked in your browser; the router is not asked whether it is real.')),
    h(
      'div',
      { class: 'grid-2 reveal', 'data-delay': '1' },
      h('div', { class: 'card', style: { display: 'grid', gap: '12px' } }, h('label', { class: 'field' }, h('span', null, 'Receipt or job id'), idInput), h('div', { class: 'row' }, lookup)),
      h('div', { class: 'card', style: { display: 'grid', gap: '12px' } }, h('label', { class: 'field' }, h('span', null, 'Receipt JSON'), paste), h('div', { class: 'row' }, check)),
    ),
    out,
  );
  const stopReveal = mountReveals(el);
  if (initialId) void doLookup();
  return { el, title: 'Verify', unmount: stopReveal };
}
