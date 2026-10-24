import type { Receipt } from '@docket/shared';
import { h, fmtCr, fmtMs } from './dom';

function short(s: string, n = 14): string {
  return s.length <= n ? s : s.slice(0, n) + '…';
}

export function receiptEl(r: Receipt, opts: { verified?: boolean; compact?: boolean } = {}): HTMLElement {
  const b = r.body;
  const when = new Date(b.finishedAt);
  const line = (k: string, v: string, cls = '') => h('div', { class: `line ${cls}` }, h('span', null, k), h('span', null, v));
  return h(
    'div',
    { class: `receipt ${opts.verified ? 'is-verified' : ''}` },
    h('div', { class: 'head' }, h('b', null, 'Docket'), h('span', null, when.toLocaleDateString([], { month: 'short', day: 'numeric' }), ' ', when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))),
    line('receipt', short(r.id, 18)),
    line('job', short(b.jobId, 18)),
    h('hr', { class: 'dots' }),
    line('workload', b.workload),
    line('model', b.model),
    line('ran on', `${short(b.nodeId, 12)} (${b.nodeClass})`),
    line('took', fmtMs(b.finishedAt - b.startedAt)),
    line(b.workload === 'llm' ? 'output tokens' : 'work units', String(b.workload === 'llm' ? b.outputTokens : b.units)),
    h('hr', { class: 'dots' }),
    line('cost', `${fmtCr(b.costMicro)}`, 'big'),
    opts.compact
      ? null
      : [
          h('hr', { class: 'dots' }),
          line('input', short(b.inputHash, 20)),
          line('output', short(b.outputHash, 20)),
          h('div', { class: 'sig', style: { marginTop: '8px' } }, 'node ', r.nodeSig.slice(0, 40), '…'),
          h('div', { class: 'sig' }, 'router ', r.routerSig.slice(0, 40), '…'),
        ],
    h('span', { class: 'stamped' }, 'VERIFIED'),
  );
}

/** A believable placeholder while the network has not produced a real one yet. Clearly labelled by the caller. */
export function sampleReceipt(): Receipt {
  const now = Date.now();
  return {
    id: 'rcpt_waiting',
    body: {
      v: 1,
      jobId: 'job_waiting',
      nodeId: 'nd_waiting',
      nodeClass: 'browser',
      workload: 'llm',
      model: 'qwen2.5-0.5b-instruct',
      inputHash: '—',
      outputHash: '—',
      outputTokens: 0,
      units: 0,
      startedAt: now,
      finishedAt: now,
      costMicro: 0,
    },
    nodeSig: '—',
    routerSig: '—',
    nodeKey: '—',
    routerKey: '—',
  };
}
