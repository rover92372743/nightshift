// The console: a terminal for the people who send work. Sign in with an API
// key, send a task by typing or with the form, watch it route, read the
// receipt. The operator signs in with the admin key and gets a few more
// commands: accounts, grants, inquiries. Same page, same prompt.

import type { JobRecord, LedgerEntry, Receipt } from '@nightshift/shared';
import { api, ApiError, session, API_BASE, type AdminAccount, type BatchSummary, type PayoutReview } from '../lib/api';
import { h, fmtMs, fmtUsd, timeHM, isPreview, mountReveals } from '../lib/dom';
import { live } from '../lib/live';
import type { Page } from '../main';

type Cmd = (args: string[], raw: string) => Promise<unknown> | unknown;

const MODELS = ['qwen2.5-0.5b-instruct', 'qwen2.5-7b-instruct', 'llama-3.1-8b-instruct', 'smollm2-360m-instruct'];

export function consolePage(): Page {
  const term = h('div', { class: 'term console-term', role: 'log', 'aria-live': 'polite' });
  const promptSign = h('span', { class: 'console-sign' }, '$');
  const input = h('input', { class: 'console-input', type: 'text', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off', 'aria-label': 'Console command', placeholder: 'type help' }) as HTMLInputElement;
  const inputRow = h('div', { class: 'console-row' }, promptSign, input);
  const history: string[] = [];
  let hIdx = -1;
  let busy = false;
  let watching = new Set<string>();

  // --- output helpers ---------------------------------------------------------
  function out(text: string, cls = ''): HTMLElement {
    const el = h('div', { class: `console-line ${cls}` }, text);
    term.appendChild(el);
    while (term.children.length > 600) term.firstElementChild?.remove();
    term.scrollTop = term.scrollHeight;
    return el;
  }
  const dim = (t: string) => out(t, 'dim');
  const ok = (t: string) => out(t, 'ok');
  const bad = (t: string) => out(t, 'bad');
  function table(rows: string[][]): void {
    if (!rows.length) return;
    const w = rows[0].map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length)));
    rows.forEach((r, i) => out(r.map((c, j) => (c ?? '').padEnd(w[j] + 2)).join('').trimEnd(), i === 0 ? 'dim' : ''));
  }
  function echo(cmd: string): void {
    const el = h('div', { class: 'console-line cmd' }, h('span', { class: 'console-sign' }, whoSign()), ' ', cmd);
    term.appendChild(el);
    term.scrollTop = term.scrollHeight;
  }
  function whoSign(): string {
    return session.admin() ? '#' : session.key() ? '$' : '>';
  }
  function paintSign(): void {
    promptSign.textContent = whoSign();
    promptSign.className = `console-sign ${session.admin() ? 'admin' : session.key() ? 'key' : ''}`;
  }

  // --- job watching -------------------------------------------------------------
  function describe(j: JobRecord): string {
    const what = j.input.workload === 'llm' ? `${j.input.model} · ${j.input.maxOutputTokens ?? '?'} max tokens` : `compute · ${j.input.rounds ?? '?'} rounds`;
    return `${j.id}  ${j.status.padEnd(8)} ${what}${j.input.billing === 'time' ? ` · time-billed, ≤${j.input.maxSeconds ?? '?'}s` : ''}`;
  }
  async function watch(jobId: string): Promise<void> {
    if (watching.has(jobId)) return;
    watching.add(jobId);
    const line = dim(`${jobId}  queued · waiting for a node that fits…`);
    const started = Date.now();
    let lastStatus = 'queued';
    try {
      for (;;) {
        await new Promise((r) => setTimeout(r, 700));
        const j = await api.job(jobId);
        if (j.status !== lastStatus) {
          lastStatus = j.status;
          if (j.status === 'assigned') line.textContent = `${jobId}  assigned → ${live.nodes.get(j.nodeId ?? '')?.label ?? j.nodeId ?? 'node'}`;
          if (j.status === 'running') line.textContent = `${jobId}  running on ${live.nodes.get(j.nodeId ?? '')?.label ?? j.nodeId ?? 'node'}…`;
        }
        if (j.status === 'done') {
          line.remove();
          ok(`${jobId}  done on ${live.nodes.get(j.nodeId ?? '')?.label ?? j.nodeId} · ${fmtMs(j.output?.durationMs ?? 0)} · ${j.output?.units ?? 0} units · ${fmtUsd(j.costMicro ?? 0)} charged (${fmtUsd(j.priceMicro)} held)`);
          if (j.output?.text) out(j.output.text, 'reply');
          if (j.output?.digest) dim(`digest ${j.output.digest}`);
          if (j.receipt) dim(`receipt ${j.receipt.id}  ·  type "receipt ${j.receipt.id}" to verify, or open /receipts/${j.receipt.id}`);
          return;
        }
        if (j.status === 'failed') {
          line.remove();
          bad(`${jobId}  failed: ${j.error ?? 'unknown'} · hold refunded`);
          return;
        }
        if (Date.now() - started > 120_000) {
          line.textContent = `${jobId}  still ${j.status} after 2 min; it stays in the queue. "job ${jobId}" to check later.`;
          return;
        }
      }
    } catch (e) {
      line.remove();
      bad(`${jobId}  ${(e as Error).message}`);
    } finally {
      watching.delete(jobId);
    }
  }

  async function send(body: Record<string, unknown>): Promise<void> {
    try {
      const j = await api.submitJob(body);
      dim(`→ ${describe(j)} · hold ${fmtUsd(j.priceMicro)}`);
      void watch(j.id);
    } catch (e) {
      bad(errText(e));
    }
  }

  function printBatch(bt: BatchSummary): void {
    const pending = bt.counts.queued + bt.counts.assigned + bt.counts.running;
    out(`${bt.id}${bt.label ? `  ${bt.label}` : ''}  ${bt.counts.done}/${bt.total} done · ${bt.counts.failed} failed · ${pending} pending · ${fmtUsd(bt.costMicro)} charged${bt.heldMicro ? ` · ${fmtUsd(bt.heldMicro)} held` : ''}`);
  }
  const watchingBatches = new Set<string>();
  async function watchBatch(id: string): Promise<void> {
    if (watchingBatches.has(id)) return;
    watchingBatches.add(id);
    const line = dim(`${id}  starting…`);
    const bar = (done: number, failed: number, total: number) => {
      const w = 24;
      const d = Math.round((done / total) * w);
      const f = Math.round((failed / total) * w);
      return '[' + '█'.repeat(d) + '×'.repeat(f) + '·'.repeat(Math.max(0, w - d - f)) + ']';
    };
    try {
      for (;;) {
        const bt = await api.batch(id);
        const finished = bt.counts.done + bt.counts.failed;
        line.textContent = `${id}  ${bar(bt.counts.done, bt.counts.failed, bt.total)} ${finished}/${bt.total} · ${bt.counts.running} running · ${fmtUsd(bt.costMicro)} so far`;
        if (finished >= bt.total) {
          line.remove();
          (bt.counts.failed ? out : ok)(`${id}  finished: ${bt.counts.done} done, ${bt.counts.failed} failed · ${fmtUsd(bt.costMicro)} charged · "results ${id}" to download`, bt.counts.failed ? 'bad' : 'ok');
          return;
        }
        await new Promise((r) => setTimeout(r, 1200));
      }
    } catch (e) {
      line.remove();
      bad(`${id}  ${(e as Error).message}`);
    } finally {
      watchingBatches.delete(id);
    }
  }

  function errText(e: unknown): string {
    if (e instanceof ApiError) return e.status === 401 ? 'not signed in, or the key is wrong. "login <key>"' : e.status === 402 ? `${e.message}. Ask the operator for credits.` : e.message;
    return (e as Error).message;
  }

  // --- flags ---------------------------------------------------------------------
  function flags(args: string[]): { words: string[]; f: Record<string, string> } {
    const f: Record<string, string> = {};
    const words: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a.startsWith('--')) {
        const [k, v] = a.slice(2).split('=');
        f[k] = v ?? (args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : 'true');
      } else words.push(a);
    }
    return { words, f };
  }

  // --- commands ----------------------------------------------------------------------
  const cmds: Record<string, { help: string; run: Cmd; admin?: boolean }> = {
    help: {
      help: 'help                 this list',
      run: () => {
        out('commands', 'dim');
        Object.entries(cmds)
          .filter(([, c]) => !c.admin || session.admin())
          .forEach(([k, c]) => out(`  ${c.help.startsWith(k) ? c.help : `${k.padEnd(21)}${c.help}`}`));
        if (!session.admin()) dim('operator? "admin <key>" unlocks accounts, grant, keys, quotes.');
      },
    },
    login: {
      help: 'login <ns_key>       sign in with an API key',
      run: async ([k]) => {
        if (!k) return bad('usage: login <ns_key>');
        session.setKey(k.trim());
        try {
          const me = await api.me();
          paintSign();
          ok(`signed in as ${me.label ?? me.accountId} (${me.accountId}) · balance ${fmtUsd(me.balanceMicro)}`);
          paintWho(me);
        } catch (e) {
          session.setKey(null);
          paintSign();
          bad(errText(e));
        }
      },
    },
    logout: {
      help: 'logout               forget the key in this tab',
      run: () => {
        session.setKey(null);
        session.setAdmin(null);
        paintSign();
        dim('signed out.');
        payPanel.hidden = true;
        closeConsole();
      },
    },
    me: {
      help: 'me                   account, balance, recent ledger',
      run: async () => {
        if (session.admin() && !session.key()) {
          out('operator · no business account on this sign-in. "accounts", "keys new", "grant", "quotes", "all".');
          who.replaceChildren(h('span', { class: 'tag' }, 'operator'));
          return;
        }
        const me = await api.me();
        paintWho(me);
        out(`account   ${me.accountId}${me.label ? `  (${me.label})` : ''}  ${me.kind ?? ''}`);
        out(`balance   ${fmtUsd(me.balanceMicro)}`);
        if (me.ledger.length) {
          dim('recent ledger');
          table([['time', 'kind', 'amount', 'ref'], ...me.ledger.slice(0, 12).map((l: LedgerEntry) => [timeHM(l.createdAt), l.kind, (l.deltaMicro >= 0 ? '+' : '') + fmtUsd(l.deltaMicro), l.ref ?? ''])]);
        }
      },
    },
    run: {
      help: 'run <prompt> [--model m] [--max n] [--time secs]   send an LLM task',
      run: async (args) => {
        const { words, f } = flags(args);
        const prompt = words.join(' ').replace(/^"(.*)"$/, '$1');
        if (!prompt) return bad('usage: run <prompt> [--model qwen2.5-0.5b-instruct] [--max 160] [--time 30]');
        const body: Record<string, unknown> = { workload: 'llm', model: f.model ?? MODELS[0], messages: [{ role: 'user', content: prompt }], maxOutputTokens: Number(f.max ?? 160) };
        if (f.time) Object.assign(body, { billing: 'time', maxSeconds: Number(f.time) });
        await send(body);
      },
    },
    compute: {
      help: 'compute <rounds> [--time secs]          send a hash-chain compute task',
      run: async (args) => {
        const { words, f } = flags(args);
        const rounds = Number(words[0] ?? 50_000);
        if (!Number.isFinite(rounds) || rounds < 1000) return bad('rounds: a number ≥ 1000, e.g. compute 50000');
        const body: Record<string, unknown> = { workload: 'compute', rounds, seed: Math.floor(Math.random() * 1e9) };
        if (f.time) Object.assign(body, { billing: 'time', maxSeconds: Number(f.time) });
        await send(body);
      },
    },
    jobs: {
      help: 'jobs                 your last 20 tasks',
      run: async () => {
        const { jobs } = await api.jobs();
        if (!jobs.length) return dim('no tasks yet. try: run "Two lines on why receipts matter."');
        table([['id', 'status', 'what', 'node', 'cost', 'when'], ...jobs.map((j) => [j.id, j.status, j.input.workload === 'llm' ? j.input.model : `compute ${j.input.rounds}`, live.nodes.get(j.nodeId ?? '')?.label ?? j.nodeId ?? '', j.costMicro !== undefined ? fmtUsd(j.costMicro) : `(${fmtUsd(j.priceMicro)} held)`, timeHM(j.createdAt)])]);
      },
    },
    job: {
      help: 'job <id>             one task in full, with its receipt',
      run: async ([id]) => {
        if (!id) return bad('usage: job <id>');
        const j = await api.job(id);
        out(describe(j));
        out(`created ${timeHM(j.createdAt)}${j.startedAt ? ` · started ${timeHM(j.startedAt)}` : ''}${j.finishedAt ? ` · finished ${timeHM(j.finishedAt)}` : ''} · attempts ${j.attempts}`);
        if (j.nodeId) out(`node    ${live.nodes.get(j.nodeId)?.label ?? j.nodeId}`);
        out(`money   held ${fmtUsd(j.priceMicro)}${j.costMicro !== undefined ? ` · charged ${fmtUsd(j.costMicro)}` : ''}`);
        if (j.output?.text) out(j.output.text, 'reply');
        if (j.output?.digest) dim(`digest ${j.output.digest}`);
        if (j.error) bad(`error   ${j.error}`);
        if (j.receipt) {
          dim(`receipt ${j.receipt.id}`);
          await showReceipt(j.receipt);
        } else if (j.status === 'queued' || j.status === 'assigned' || j.status === 'running') void watch(j.id);
      },
    },
    receipt: {
      help: 'receipt <id>         fetch and verify a receipt',
      run: async ([id]) => {
        if (!id) return bad('usage: receipt <id>');
        const { receipt } = await api.receipt(id);
        await showReceipt(receipt);
      },
    },
    batches: {
      help: 'batches              your recent batches with progress',
      run: async () => {
        const { batches } = await api.batches();
        if (!batches.length) return dim('no batches yet. use the Batch panel on the right to upload one.');
        table([['id', 'label', 'done', 'failed', 'pending', 'cost', 'when'], ...batches.map((bt) => [bt.id, bt.label ?? '', `${bt.counts.done}/${bt.total}`, String(bt.counts.failed), String(bt.counts.queued + bt.counts.assigned + bt.counts.running), fmtUsd(bt.costMicro), timeHM(bt.createdAt)])]);
      },
    },
    batch: {
      help: 'batch <id>           progress of one batch; "batch <id> results" lists every item',
      run: async ([id, what]) => {
        if (!id) return bad('usage: batch <id> [results]');
        if (what === 'results') {
          const { items } = await api.batchResults(id);
          table([['#', 'status', 'input', 'output', 'cost'], ...items.map((it) => [String(it.index), it.status, (it.prompt ?? `compute ${it.rounds}`).slice(0, 36), (it.output ?? it.error ?? '').slice(0, 48), it.costMicro !== undefined ? fmtUsd(it.costMicro) : ''])]);
          dim(`"results ${id}" downloads the full set as JSONL.`);
          return;
        }
        const bt = await api.batch(id);
        printBatch(bt);
        if (bt.counts.done + bt.counts.failed < bt.total) void watchBatch(id);
      },
    },
    results: {
      help: 'results <id>         download a batch as JSONL',
      run: async ([id]) => {
        if (!id) return bad('usage: results <id>');
        const { items } = await api.batchResults(id);
        const blob = new Blob([items.map((x) => JSON.stringify(x)).join('\n') + '\n'], { type: 'application/x-ndjson' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${id}.jsonl`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        ok(`${items.length} items → ${id}.jsonl`);
      },
    },
    admin: {
      help: 'admin <key>          sign in as the operator',
      run: async ([k]) => {
        if (!k) return bad('usage: admin <key>');
        session.setAdmin(k.trim());
        try {
          await api.admin.me();
          paintSign();
          ok('operator mode. commands: accounts, grant, keys, quotes, all');
        } catch (e) {
          session.setAdmin(null);
          paintSign();
          bad(e instanceof ApiError && e.status === 404 ? 'admin routes are off on this router (set NIGHTSHIFT_ADMIN_KEY).' : errText(e));
        }
      },
    },
    accounts: {
      admin: true,
      help: 'accounts             every business and session account with balance',
      run: async () => {
        const { accounts } = await api.admin.accounts();
        table([['account', 'kind', 'label', 'balance', 'created'], ...accounts.map((a: AdminAccount) => [a.id, a.kind, a.label ?? '', fmtUsd(a.balanceMicro), new Date(a.createdAt).toISOString().slice(0, 10)])]);
      },
    },
    grant: {
      admin: true,
      help: 'grant <account> <credits> [note]   add credits (1 credit = $1); negative to claw back',
      run: async ([acct, n, ...note]) => {
        const credits = Number(n);
        if (!acct || !Number.isFinite(credits)) return bad('usage: grant acct_… 250 "invoice 1042"');
        const r = await api.admin.grant(acct, credits, note.join(' ') || undefined);
        ok(`${acct} ${credits >= 0 ? '+' : ''}${credits} → balance ${fmtUsd(r.balanceMicro)}`);
      },
    },
    keys: {
      admin: true,
      help: 'keys new <label> [credits]   mint a key for a business, with an opening balance',
      run: async ([sub, ...rest]) => {
        if (sub !== 'new') return bad('usage: keys new "Acme eval team" 500');
        const last = rest[rest.length - 1];
        const credits = rest.length > 1 && /^\d+(\.\d+)?$/.test(last) ? Number(rest.pop()) : 0;
        const r = await api.admin.keys(rest.join(' ').replace(/^"(.*)"$/, '$1') || 'business key', credits);
        ok(`account ${r.accountId} · ${r.label} · balance ${fmtUsd(r.balanceMicro)}`);
        out(`key     ${r.apiKey}`, 'reply');
        dim('send this to the business over a channel you trust; the router only keeps a hash.');
      },
    },
    quotes: {
      admin: true,
      help: 'quotes               inquiries from the pricing page',
      run: async () => {
        const { quotes } = await api.admin.quotes();
        if (!quotes.length) return dim('no inquiries yet.');
        for (const q of quotes) {
          out(`${new Date(q.createdAt).toISOString().slice(0, 16).replace('T', ' ')}  ${q.company || '—'}  <${q.email}>`);
          dim(`  ${q.need.slice(0, 300)}`);
        }
      },
    },
    payouts: {
      admin: true,
      help: 'payouts              the payout review queue (pending first)',
      run: async () => {
        const { payouts } = await api.admin.payouts();
        if (!payouts.length) return dim('no payout requests.');
        table([['id', 'status', 'requester', 'amount', 'balance', 'address', 'when'], ...payouts.slice(0, 30).map((p) => [p.id, p.status, `${p.nodeLabel} (${p.nodeId.slice(0, 10)})`, fmtUsd(p.amountMicro), fmtUsd(p.balanceMicro), p.address, timeHM(p.createdAt)])]);
        dim('approve <id> <tx reference>  after you have sent the USDC · reject <id> [reason]  puts the credits back');
        void refreshPayouts();
      },
    },
    approve: {
      admin: true,
      help: 'approve <id> <txref> record that the USDC was sent',
      run: async ([id, tx, ...note]) => {
        if (!id || !tx) return bad('usage: approve po_… <solana transaction signature>');
        const { payout } = await api.admin.approvePayout(id, tx, note.join(' ') || undefined);
        ok(`${payout.id} sent · ${fmtUsd(payout.amountMicro)} USDC → ${payout.address} · ${payout.txRef}`);
        void refreshPayouts();
      },
    },
    reject: {
      admin: true,
      help: 'reject <id> [reason]  decline a payout; credits return to the account',
      run: async ([id, ...reason]) => {
        if (!id) return bad('usage: reject po_… [reason]');
        const { payout } = await api.admin.rejectPayout(id, reason.join(' ') || undefined);
        out(`${payout.id} rejected · ${fmtUsd(payout.amountMicro)} returned to ${payout.nodeLabel}`, 'bad');
        void refreshPayouts();
      },
    },
    all: {
      admin: true,
      help: 'all                  the last 50 tasks across every account (content hidden)',
      run: async () => {
        const { jobs } = await api.admin.jobs();
        table([['id', 'status', 'account', 'what', 'node', 'cost', 'when'], ...jobs.map((j) => [j.id, j.status, j.requesterId.slice(0, 14), j.input.workload === 'llm' ? j.input.model : `compute ${j.input.rounds}`, live.nodes.get(j.nodeId ?? '')?.label ?? j.nodeId ?? '', j.costMicro !== undefined ? fmtUsd(j.costMicro) : '', timeHM(j.createdAt)])]);
      },
    },
    clear: {
      help: 'clear                wipe the screen',
      run: () => term.replaceChildren(),
    },
  };

  async function showReceipt(r: Receipt): Promise<void> {
    const v = await api.verify(r);
    out(`job ${r.body.jobId} · node ${r.body.nodeId} · ${r.body.model} · ${r.body.units} units · ${fmtUsd(r.body.costMicro)} · ${fmtMs(r.body.finishedAt - r.body.startedAt)}`);
    out(`input  ${r.body.inputHash}`);
    out(`output ${r.body.outputHash}`);
    (v.valid ? ok : bad)(`node signature ${v.nodeSignature ? 'ok' : 'BAD'} · router signature ${v.routerSignature ? 'ok' : 'BAD'} · ${v.routerIsThisRouter ? 'signed by this router' : 'signed by another router'}`);
  }

  async function exec(raw: string): Promise<void> {
    const line = raw.trim();
    if (!line) return;
    echo(line);
    history.unshift(line);
    hIdx = -1;
    const args = tokenize(line);
    const name = args.shift()!.toLowerCase();
    const c = cmds[name];
    if (!c) {
      bad(`unknown command "${name}". "help" lists them.`);
      return;
    }
    if (c.admin && !session.admin()) {
      bad('operator command. "admin <key>" first.');
      return;
    }
    busy = true;
    input.disabled = true;
    try {
      await c.run(args, line);
    } catch (e) {
      bad(errText(e));
    } finally {
      busy = false;
      input.disabled = false;
      input.focus();
    }
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !busy) {
      const v = input.value;
      input.value = '';
      void exec(v);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (hIdx < history.length - 1) input.value = history[++hIdx];
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      hIdx = Math.max(-1, hIdx - 1);
      input.value = hIdx === -1 ? '' : history[hIdx];
    } else if (e.key === 'l' && e.ctrlKey) {
      e.preventDefault();
      term.replaceChildren();
    }
  });

  // --- the form (same thing as "run", for people who'd rather click) --------------
  const fWorkload = h('select', { class: 'select' }, h('option', { value: 'llm' }, 'Language model'), h('option', { value: 'compute' }, 'Compute (hash chain)')) as HTMLSelectElement;
  const fModel = h('select', { class: 'select' }, MODELS.map((m) => h('option', { value: m }, m))) as HTMLSelectElement;
  const fPrompt = h('textarea', { class: 'input', rows: 5, placeholder: 'What should the model do? Operators never see this text; it is hashed into the receipt.' }) as HTMLTextAreaElement;
  const fMax = h('input', { class: 'input', type: 'number', min: 16, max: 2048, step: 16, value: 160 }) as HTMLInputElement;
  const fRounds = h('input', { class: 'input', type: 'number', min: 1000, max: 5_000_000, step: 1000, value: 50000 }) as HTMLInputElement;
  const fBilling = h('select', { class: 'select' }, h('option', { value: 'tokens' }, 'Per token / unit'), h('option', { value: 'time' }, 'Per card-hour (seconds measured)')) as HTMLSelectElement;
  const fSecs = h('input', { class: 'input', type: 'number', min: 5, max: 3600, step: 5, value: 30 }) as HTMLInputElement;
  const fSend = h('button', { class: 'btn stamp' }, 'Send task') as HTMLButtonElement;
  const llmFields = h('div', { style: { display: 'grid', gap: '12px' } }, h('label', { class: 'field' }, h('span', null, 'Model'), fModel), h('label', { class: 'field' }, h('span', null, 'Prompt'), fPrompt), h('label', { class: 'field' }, h('span', null, 'Max output tokens'), fMax));
  const computeFields = h('div', { style: { display: 'grid', gap: '12px' }, hidden: true }, h('label', { class: 'field' }, h('span', null, 'Rounds'), fRounds), h('p', { class: 'small muted' }, 'A SHA-256 hash chain. Any node can take it; the router re-runs a sample to check the digest.'));
  const secsField = h('label', { class: 'field', hidden: true }, h('span', null, 'Max seconds to pay for'), fSecs);
  fWorkload.addEventListener('change', () => {
    llmFields.hidden = fWorkload.value !== 'llm';
    computeFields.hidden = fWorkload.value !== 'compute';
  });
  fBilling.addEventListener('change', () => (secsField.hidden = fBilling.value !== 'time'));
  fSend.addEventListener('click', () => {
    const body: Record<string, unknown> =
      fWorkload.value === 'llm'
        ? { workload: 'llm', model: fModel.value, messages: [{ role: 'user', content: fPrompt.value.trim() }], maxOutputTokens: Number(fMax.value) }
        : { workload: 'compute', rounds: Number(fRounds.value), seed: Math.floor(Math.random() * 1e9) };
    if (fWorkload.value === 'llm' && !fPrompt.value.trim()) return fPrompt.focus();
    if (fBilling.value === 'time') Object.assign(body, { billing: 'time', maxSeconds: Number(fSecs.value) });
    echo(fWorkload.value === 'llm' ? `run "${fPrompt.value.trim().slice(0, 60)}${fPrompt.value.trim().length > 60 ? '…' : ''}" --model ${fModel.value} --max ${fMax.value}${fBilling.value === 'time' ? ` --time ${fSecs.value}` : ''}` : `compute ${fRounds.value}${fBilling.value === 'time' ? ` --time ${fSecs.value}` : ''}`);
    void send(body);
  });

  // --- batch upload: one prompt per line, or JSONL of job inputs -------------------
  const bFile = h('input', { type: 'file', accept: '.txt,.jsonl,.json,.csv', class: 'input' }) as HTMLInputElement;
  const bLabel = h('input', { class: 'input', type: 'text', placeholder: 'eval run 3', maxlength: 80 }) as HTMLInputElement;
  const bModel = h('select', { class: 'select' }, MODELS.map((m) => h('option', { value: m }, m))) as HTMLSelectElement;
  const bMax = h('input', { class: 'input', type: 'number', min: 16, max: 2048, step: 16, value: 160 }) as HTMLInputElement;
  const bPreview = h('p', { class: 'small muted' }, 'Plain text: one prompt per line. JSONL: one job input per line (full control: workload, model, billing, maxSeconds).');
  const bSend = h('button', { class: 'btn stamp', disabled: true }, 'Send batch') as HTMLButtonElement;
  let parsed: Record<string, unknown>[] = [];
  bFile.addEventListener('change', async () => {
    const f = bFile.files?.[0];
    parsed = [];
    bSend.disabled = true;
    if (!f) return;
    const text = await f.text();
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const jsonl = f.name.endsWith('.jsonl') || f.name.endsWith('.json') || lines.every((l) => l.startsWith('{'));
    try {
      parsed = jsonl
        ? lines.map((l) => JSON.parse(l) as Record<string, unknown>)
        : lines.map((l) => ({ workload: 'llm', model: bModel.value, messages: [{ role: 'user', content: l.replace(/^"(.*)"$/, '$1') }], maxOutputTokens: Number(bMax.value) }));
    } catch (e) {
      bPreview.textContent = `could not parse: ${(e as Error).message}`;
      return;
    }
    if (parsed.length > 500) {
      bPreview.textContent = `${parsed.length} lines; a batch is at most 500. Split the file.`;
      parsed = [];
      return;
    }
    bPreview.textContent = `${parsed.length} item${parsed.length === 1 ? '' : 's'} from ${f.name}${jsonl ? ' (JSONL, inputs used as given)' : ` (prompts → ${bModel.value}, ${bMax.value} tokens each)`}.`;
    bSend.disabled = parsed.length === 0;
  });
  bSend.addEventListener('click', async () => {
    if (!parsed.length) return;
    echo(`batch upload · ${parsed.length} items${bLabel.value ? ` · "${bLabel.value}"` : ''}`);
    bSend.disabled = true;
    try {
      const r = await api.submitBatch(parsed, bLabel.value || undefined);
      ok(`${r.id}  ${r.total} items queued`);
      void watchBatch(r.id);
    } catch (e) {
      bad(errText(e));
    } finally {
      bSend.disabled = false;
    }
  });
  const batchPanel = h(
    'div',
    { class: 'card', style: { display: 'grid', gap: '12px', alignSelf: 'start' } },
    h('h3', null, 'Send a batch'),
    h('label', { class: 'field' }, h('span', null, 'File'), bFile),
    h('div', { class: 'grid-2', style: { gap: '12px' } }, h('label', { class: 'field' }, h('span', null, 'Model (for plain text)'), bModel), h('label', { class: 'field' }, h('span', null, 'Max tokens each'), bMax)),
    h('label', { class: 'field' }, h('span', null, 'Label'), bLabel),
    bPreview,
    h('div', { class: 'row' }, bSend),
    h('p', { class: 'small muted' }, 'Up to 500 items per batch, held for as one transaction. Progress shows in the terminal; "results <id>" downloads JSONL.'),
  );

  // --- operator: payout review -------------------------------------------------------
  // Every request shows who is asking, the address, the amount, and the
  // account's balance, plus the sanity numbers (lifetime earnings, tasks,
  // prior requests, whether another account uses the same address). Nothing
  // is sent from here; the operator sends from the treasury wallet and
  // records the transaction.
  const payTable = h('div', { class: 'pay-table' });
  const payPanel = h('div', { class: 'card pay-panel', hidden: true }, h('div', { class: 'row', style: { justifyContent: 'space-between', alignItems: 'baseline' } }, h('h3', null, 'Payout requests'), h('button', { class: 'btn sm secondary', onClick: () => void refreshPayouts() }, 'Refresh')), h('p', { class: 'small muted' }, 'Review each one, send the USDC from the treasury wallet, then record the transaction here. Rejecting returns the credits.'), payTable);
  async function refreshPayouts(): Promise<void> {
    if (!session.admin()) return;
    try {
      const { payouts } = await api.admin.payouts();
      payPanel.hidden = false;
      const pending = payouts.filter((p) => p.status === 'pending');
      const done = payouts.filter((p) => p.status !== 'pending').slice(0, 10);
      payTable.replaceChildren(
        pending.length ? h('div', { class: 'pay-h' }, `${pending.length} waiting`) : h('p', { class: 'small muted' }, 'Nothing waiting.'),
        ...pending.map(payRow),
        ...(done.length ? [h('div', { class: 'pay-h', style: { marginTop: '10px' } }, 'recent')] : []),
        ...done.map(payRow),
      );
    } catch (e) {
      payTable.replaceChildren(h('p', { class: 'small', style: { color: '#ff7b7b' } }, errText(e)));
    }
  }
  function payRow(p: PayoutReview): HTMLElement {
    const flags: string[] = [];
    if (p.amountMicro > p.earnedMicro) flags.push('asks for more than it ever earned');
    if (p.addressSharedWith > 0) flags.push(`address also used by ${p.addressSharedWith} other account${p.addressSharedWith === 1 ? '' : 's'}`);
    if (p.jobsDone < 5) flags.push(`only ${p.jobsDone} task${p.jobsDone === 1 ? '' : 's'} done`);
    const tx = h('input', { class: 'input mono', placeholder: 'transaction signature', spellcheck: 'false' }) as HTMLInputElement;
    const approveBtn = h('button', { class: 'btn sm stamp' }, 'Mark sent') as HTMLButtonElement;
    const rejectBtn = h('button', { class: 'btn sm secondary' }, 'Reject') as HTMLButtonElement;
    approveBtn.addEventListener('click', () => void exec(`approve ${p.id} ${tx.value.trim()}`));
    rejectBtn.addEventListener('click', () => {
      const why = window.prompt('Reason (shown to the requester, optional):') ?? '';
      void exec(`reject ${p.id} ${why}`.trim());
    });
    return h(
      'div',
      { class: `pay-row ${p.status}` },
      h('div', { class: 'pay-top' }, h('b', null, fmtUsd(p.amountMicro)), h('span', { class: 'tag' }, p.status), h('span', { class: 'small muted' }, timeHM(p.createdAt))),
      h('div', { class: 'kv' },
        h('span', null, 'requester'), h('span', null, `${p.nodeLabel} · `, h('code', { class: 'small' }, p.nodeId)),
        h('span', null, 'address'), h('code', { class: 'small', style: { wordBreak: 'break-all' } }, p.address),
        h('span', null, 'balance now'), h('span', null, `${fmtUsd(p.balanceMicro)} after this hold`),
        h('span', null, 'lifetime'), h('span', null, `${fmtUsd(p.earnedMicro)} across ${p.jobsDone} task${p.jobsDone === 1 ? '' : 's'} · ${p.priorRequests} prior request${p.priorRequests === 1 ? '' : 's'}`),
        ...(p.txRef ? [h('span', null, 'tx'), h('code', { class: 'small', style: { wordBreak: 'break-all' } }, p.txRef)] : []),
        ...(p.note ? [h('span', null, 'note'), h('span', null, p.note)] : []),
      ),
      flags.length ? h('p', { class: 'small pay-flag' }, '⚠ ' + flags.join(' · ')) : null,
      p.status === 'pending' ? h('div', { class: 'row' }, tx, approveBtn, rejectBtn) : null,
    );
  }

  // --- sign-in gate: nothing is shown until a key or the admin key checks out ----------
  const gKey = h('input', { class: 'input', type: 'password', placeholder: 'ns_…', autocomplete: 'off', spellcheck: 'false' }) as HTMLInputElement;
  const gBtn = h('button', { class: 'btn stamp' }, 'Sign in') as HTMLButtonElement;
  const gErr = h('p', { class: 'small', style: { color: '#ff7b7b', minHeight: '1.2em' } });
  const rCompany = h('input', { class: 'input', type: 'text', placeholder: 'Company', maxlength: 120 }) as HTMLInputElement;
  const rEmail = h('input', { class: 'input', type: 'email', placeholder: 'you@company.com', maxlength: 200 }) as HTMLInputElement;
  const rNeed = h('textarea', { class: 'input', rows: 3, placeholder: 'What you want to run' }) as HTMLTextAreaElement;
  const rBtn = h('button', { class: 'btn secondary' }, 'Send request') as HTMLButtonElement;
  const rMsg = h('p', { class: 'small muted' });
  rBtn.addEventListener('click', async () => {
    rBtn.disabled = true;
    try {
      await api.access({ company: rCompany.value.trim(), email: rEmail.value.trim(), need: rNeed.value.trim() });
      rMsg.textContent = 'Received. We will be in touch.';
      rCompany.value = rEmail.value = rNeed.value = '';
    } catch (e) {
      rMsg.textContent = errText(e);
    } finally {
      rBtn.disabled = false;
    }
  });
  const gate = h(
    'div',
    { class: 'console-gate reveal' },
    h(
      'div',
      { class: 'card flush term-card console-gate-card' },
      h('div', { class: 'term-bar' }, h('span'), h('span'), h('span'), h('b', null, 'nightshift console · sign in')),
      h(
        'div',
        { style: { padding: '18px 16px', display: 'grid', gap: '12px' } },
        h('p', { class: 'small', style: { color: '#9aa7b8', margin: 0 } }, 'Paste your key.'),
        h('div', { class: 'row' }, gKey, gBtn),
        gErr,
        isPreview() ? h('p', { class: 'small', style: { color: '#7d8aa0', margin: 0 } }, 'Preview key: admin-preview') : null,
      ),
    ),
    h(
      'div',
      { class: 'card', style: { display: 'grid', gap: '12px', alignSelf: 'start' } },
      h('h3', null, 'Request access'),
      h('div', { class: 'grid-2', style: { gap: '12px' } }, h('label', { class: 'field' }, h('span', null, 'Company'), rCompany), h('label', { class: 'field' }, h('span', null, 'Email'), rEmail)),
      h('label', { class: 'field' }, h('span', null, 'What you need'), rNeed),
      h('div', { class: 'row' }, rBtn),
      rMsg,
    ),
  );
  async function trySignIn(): Promise<void> {
    const k = gKey.value.trim();
    if (!k) return;
    gBtn.disabled = true;
    gErr.textContent = '';
    session.setKey(null);
    session.setAdmin(null);
    try {
      // try as operator first, then as a business key
      session.setAdmin(k);
      try {
        await api.admin.me();
      } catch {
        session.setAdmin(null);
        session.setKey(k);
        await api.me();
      }
      gKey.value = '';
      openConsole();
      await exec('me');
    } catch (e) {
      session.setKey(null);
      session.setAdmin(null);
      gErr.textContent = e instanceof ApiError && e.status === 401 ? "That key didn't check out." : errText(e);
    } finally {
      gBtn.disabled = false;
    }
  }
  gBtn.addEventListener('click', () => void trySignIn());
  gKey.addEventListener('keydown', (e) => e.key === 'Enter' && void trySignIn());

  // --- who's signed in ----------------------------------------------------------------
  const who = h('div', { class: 'console-who' });
  function paintWho(me: { accountId: string; label?: string | null; balanceMicro: number } | null): void {
    if (!me) {
      who.replaceChildren(h('span', { class: 'tag' }, 'not signed in'));
      return;
    }
    who.replaceChildren(h('span', { class: 'tag' }, session.admin() ? 'operator' : session.key() ? 'business' : 'session'), h('b', null, me.label || me.accountId), h('span', { class: 'mono small' }, me.accountId), h('span', { class: 'console-balance' }, fmtUsd(me.balanceMicro)));
  }
  const refreshWho = () => api.me().then(paintWho).catch(() => paintWho(null));

  // --- boot --------------------------------------------------------------------------
  const banner = [
    `nightshift console · ${API_BASE || location.host}`,
    'send tasks, watch them route, read the receipts.',
    '',
  ];
  banner.forEach((l) => dim(l));
  dim('type "help" for commands, or use the panels. ↑ recalls history.');
  paintSign();

  const keyLink = h('a', { href: '/docs/console' }, 'Guide');
  const el = h(
    'div',
    { class: 'page console-page' },
    h(
      'section',
      { class: 'section' },
      h(
        'div',
        { class: 'container' },
        h('div', { class: 'section-head reveal' }, h('h1', null, 'Console'), h('p', null, 'Send work, watch it run, keep the receipts. ', keyLink, '.')),
        gate,
        h(
          'div',
          { class: 'console-grid', hidden: true },
          h('div', { class: 'card flush term-card console-card' }, h('div', { class: 'term-bar' }, h('span'), h('span'), h('span'), h('b', null, 'nightshift console'), who), term, inputRow),
          h(
            'div',
            { style: { display: 'grid', gap: '18px', alignSelf: 'start' } },
            h(
              'div',
              { class: 'card', style: { display: 'grid', gap: '12px' } },
              h('h3', null, 'Send a task'),
              h('label', { class: 'field' }, h('span', null, 'Kind'), fWorkload),
              llmFields,
              computeFields,
              h('label', { class: 'field' }, h('span', null, 'Billing'), fBilling),
              secsField,
              h('div', { class: 'row' }, fSend),
              h('p', { class: 'small muted' }, 'The router picks the cheapest idle machine that fits, holds the quoted amount, and charges what was actually used.'),
            ),
            batchPanel,
            payPanel,
          ),
        ),
      ),
    ),
  );
  const grid = el.querySelector<HTMLElement>('.console-grid')!;
  function openConsole(): void {
    gate.hidden = true;
    grid.hidden = false;
    paintSign();
    void refreshWho();
    payPanel.hidden = !session.admin();
    void refreshPayouts();
    setTimeout(() => input.focus(), 50);
  }
  function closeConsole(): void {
    grid.hidden = true;
    gate.hidden = false;
    paintWho(null);
    setTimeout(() => gKey.focus(), 50);
  }
  if (session.key() || session.admin()) {
    // a key from earlier in this tab: check it still works
    (session.admin() ? api.admin.me() : api.me())
      .then(() => {
        openConsole();
        void exec('me');
      })
      .catch(() => {
        session.setKey(null);
        session.setAdmin(null);
        closeConsole();
      });
  } else closeConsole();
  const unreveal = mountReveals(el);
  el.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('.console-card') && !window.getSelection()?.toString()) input.focus();
  });
  return { el, title: 'Console · Nightshift', unmount: () => unreveal() };
}

/** Split on spaces, honouring double quotes. */
function tokenize(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out;
}
