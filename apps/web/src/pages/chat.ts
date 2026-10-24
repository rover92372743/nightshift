import type { ChatMessage, LiveEvent, Receipt } from '@docket/shared';
import { h, clear, fmtCr, fmtMs, mountReveals, prefersReducedMotion } from '../lib/dom';
import { api, ApiError } from '../lib/api';
import { live } from '../lib/live';
import { receiptEl } from '../lib/receipt';
import type { Page } from '../main';

const MODEL = 'qwen2.5-0.5b-instruct';

export function chatPage(): Page {
  const history: ChatMessage[] = [{ role: 'system', content: 'You are a concise assistant. Answer in a few sentences.' }];

  const log = h('div', { class: 'chat-log' });
  const input = h('textarea', { class: 'textarea', rows: 2, placeholder: 'Ask something small. Output is capped at 160 tokens.', 'aria-label': 'Message' }) as HTMLTextAreaElement;
  const send = h('button', { class: 'btn', type: 'submit' }, 'Send') as HTMLButtonElement;
  const form = h('form', { class: 'chat-compose', onSubmit: (e: Event) => { e.preventDefault(); void submit(); } }, input, send) as HTMLFormElement;
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  // --- side panel: balance, route, receipt --------------------------------
  const balance = h('div', { class: 'earn-big' }, '—');
  const balanceNote = h('p', { class: 'small muted' }, 'Anonymous session. The router gave you a small allowance to try things.');
  const steps = ['queued', 'assigned to a node', 'running', 'receipt issued'].map((label) =>
    h('div', { class: 'step' }, h('i'), h('span', null, label), h('small')),
  );
  const route = h('div', { class: 'route' }, steps);
  const receiptSlot = h('div', { class: 'printer', style: { marginTop: '16px' } });
  const sideNote = h('p', { class: 'small muted', style: { marginTop: '10px' } }, 'Send a message and the route lights up as it happens.');

  function resetRoute(): void {
    steps.forEach((s) => {
      s.classList.remove('on', 'now');
      s.lastElementChild!.textContent = '';
    });
  }
  function markStep(i: number, now = false): void {
    steps.forEach((s, j) => {
      s.classList.toggle('on', j < i || (j === i && !now));
      s.classList.toggle('now', j === i && now);
    });
    steps[i].lastElementChild!.textContent = new Date().toLocaleTimeString([], { minute: '2-digit', second: '2-digit' });
  }

  async function refreshBalance(): Promise<void> {
    try {
      const me = await api.me();
      balance.firstChild!.textContent = fmtCr(me.balanceMicro);
    } catch {
      balance.firstChild!.textContent = '—';
    }
  }

  // Watch the live feed for our own job so the steps move in real time.
  let watching: string | null = null;
  const unsub = live.subscribe((ev: LiveEvent) => {
    if (!watching) return;
    if (ev.t === 'job.assigned' && ev.jobId === watching) markStep(1, false), markStep(2, true);
    if (ev.t === 'job.failed' && ev.jobId === watching) sideNote.textContent = ev.reason;
  });

  function bubble(role: string, text: string): HTMLElement {
    const m = h('div', { class: `msg ${role}` }, text);
    log.appendChild(m);
    log.scrollTop = log.scrollHeight;
    return m;
  }

  async function submit(): Promise<void> {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    send.disabled = true;
    history.push({ role: 'user', content: text });
    bubble('user', text);
    resetRoute();
    receiptSlot.replaceChildren();
    sideNote.textContent = 'Asking the router for a node…';
    markStep(0, true);

    const thinking = bubble('assistant', '');
    thinking.appendChild(h('span', { class: 'spinner' }));

    // The completions call blocks until done. We don't get the job id until
    // it returns, so we watch for the most recent queued job instead.
    const seen = (ev: LiveEvent) => {
      if (ev.t === 'job.queued' && !watching) watching = ev.jobId;
    };
    const off = live.subscribe(seen);

    try {
      const res = await api.chat({ model: MODEL, messages: history, max_tokens: 160, temperature: 0.7 });
      const reply = res.choices[0]?.message.content ?? '';
      history.push({ role: 'assistant', content: reply });
      thinking.textContent = reply || '(empty reply)';
      markStep(3, false);
      steps.forEach((s) => s.classList.add('on'));
      sideNote.textContent = `Ran on ${res.docket.node_id?.slice(0, 12)} in ${fmtMs(res.docket.duration_ms)}, ${res.usage.completion_tokens} tokens, ${fmtCr(res.docket.cost_micro ?? 0)}.`;
      if (res.docket.receipt_id) {
        const { receipt } = await api.receipt(res.docket.receipt_id);
        showReceipt(receipt);
      }
    } catch (err) {
      thinking.remove();
      const msg = err instanceof ApiError ? err.message : 'Could not reach the router.';
      if (err instanceof ApiError && err.status === 504) {
        bubble('system', 'No node picked that up within a minute. Open the Earn page in another tab and start a node, then try again.');
      } else if (err instanceof ApiError && err.status === 402) {
        bubble('system', 'Your session is out of credits. Get a key from the docs, or run a node for a while and spend what it earns.');
      } else if (err instanceof ApiError && err.status === 429) {
        bubble('system', 'Slow down a little; the router limits how many requests a minute each address can make.');
      } else {
        bubble('system', msg);
      }
      sideNote.textContent = msg;
      history.pop();
    } finally {
      off();
      watching = null;
      send.disabled = false;
      input.focus();
      void refreshBalance();
    }
  }

  function showReceipt(r: Receipt): void {
    clear(receiptSlot);
    const rc = receiptEl(r, { compact: true });
    receiptSlot.append(h('div', { class: 'slot' }), h('div', { class: 'paper' }, rc));
    receiptSlot.classList.add('is-printing');
    setTimeout(() => rc.classList.add('is-verified'), prefersReducedMotion() ? 0 : 1500);
    receiptSlot.appendChild(h('p', { class: 'small', style: { marginTop: '10px', textAlign: 'center' } }, h('a', { href: `/receipts/${r.id}` }, 'Open this receipt in the verifier')));
  }

  bubble('system', 'Messages go to a real node on the network. If none is online you will be told, not shown a canned answer.');
  void refreshBalance();

  const el = h(
    'div',
    { class: 'container section' },
    h('div', { class: 'section-head reveal' }, h('h1', null, 'Chat'), h('p', null, 'A small model, served by whichever node is cheapest right now.')),
    h(
      'div',
      { class: 'chat reveal', 'data-delay': '1' },
      h('div', { class: 'card' }, log, form),
      h(
        'div',
        null,
        h('div', { class: 'card' }, h('p', { class: 'small muted' }, 'Balance'), balance, balanceNote),
        h('div', { class: 'card', style: { marginTop: '16px' } }, h('h3', { style: { marginBottom: '12px' } }, 'Route'), route, sideNote, receiptSlot),
      ),
    ),
  );
  const stopReveal = mountReveals(el);
  return { el, title: 'Chat', unmount: () => { unsub(); stopReveal(); } };
}
