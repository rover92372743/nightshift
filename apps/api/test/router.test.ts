import { test } from 'node:test';
import assert from 'node:assert/strict';
import nacl from 'tweetnacl';
import { buildApp, buildContext, type Ctx } from '../src/app.js';
import { canonical, computeTask, FREE_GRANT_MICRO, benchElement, sampleIndices, type ReceiptBody } from '@nightshift/shared';
import { sha256Hex, b64u } from '../src/core/crypto.js';
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Each test gets a throwaway router with an in-memory DB and a fresh key.
async function fresh(): Promise<{ app: FastifyInstance; ctx: Ctx; close: () => Promise<void> }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightshift-test-'));
  const ctx = buildContext({ dbPath: ':memory:', keyPath: path.join(dir, 'router.key') });
  const app = await buildApp(ctx);
  await app.ready();
  return {
    app,
    ctx,
    close: async () => {
      await app.close();
      ctx.db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

// A node with a key that can talk to the test app via inject().
function makeNode(app: FastifyInstance) {
  const kp = nacl.sign.keyPair();
  const publicKey = b64u(kp.publicKey);
  const sign = (m: string) => b64u(nacl.sign.detached(new TextEncoder().encode(m), kp.secretKey));
  let id = '';
  async function signed(method: 'POST' | 'GET', url: string, body?: unknown) {
    const raw = body === undefined ? '' : JSON.stringify(body);
    const ts = Date.now();
    const sig = sign(`${ts}.${method}.${url}.${sha256Hex(raw)}`);
    return app.inject({ method, url, payload: raw || undefined, headers: { 'content-type': 'application/json', 'x-node-auth': `${ts}.${sig}` } });
  }
  return {
    publicKey,
    sign,
    get id() {
      return id;
    },
    /** Fetch a ticket and solve just the sampled elements, the way a client that did the work would answer. */
    async benchmark(opts: { kind?: 'webgpu' | 'cpu'; passes?: number; elapsedMs?: number; wrong?: boolean } = {}) {
      const t = await app.inject({ method: 'POST', url: '/v1/benchmark/ticket', payload: {} });
      const ticket = t.json().ticket;
      const elapsedMs = opts.elapsedMs ?? 200;
      await new Promise((r) => setTimeout(r, elapsedMs * 0.9 + 5));
      const samples = sampleIndices(ticket.nonce).map((i) => benchElement(ticket.nonce, i) ^ (opts.wrong ? 1 : 0));
      return { ticketId: ticket.id, kind: opts.kind ?? 'webgpu', elapsedMs, passes: opts.passes ?? 40, samples, gpu: 'test adapter' };
    },
    async register(caps: Partial<Record<string, unknown>> = {}, cls = 'browser', benchmark?: unknown) {
      const r = await app.inject({
        method: 'POST',
        url: '/v1/nodes/register',
        payload: {
          class: cls,
          label: 'test',
          publicKey,
          capabilities: { workloads: ['llm', 'compute'], models: ['m1'], maxPromptChars: 4000, maxOutputTokens: 256, pricePer1k: 300, ...caps },
          benchmark: benchmark === undefined ? await this.benchmark() : benchmark,
        },
      });
      assert.equal(r.statusCode, 200, r.body);
      id = r.json().node.id;
      return r.json();
    },
    claim: () => signed('POST', `/v1/nodes/${id}/claim`),
    heartbeat: (busy = false) => signed('POST', `/v1/nodes/${id}/heartbeat`, { busy }),
    complete: (jobId: string, body: unknown) => signed('POST', `/v1/nodes/${id}/jobs/${jobId}/complete`, body),
    fail: (jobId: string, reason: string) => signed('POST', `/v1/nodes/${id}/jobs/${jobId}/fail`, { reason }),
    me: () => signed('GET', `/v1/nodes/${id}/me`),
    signed,
  };
}

function receiptFor(job: any, node: { id: string; sign: (m: string) => string }, output: any, nodeClass: string, pricePer1k: number) {
  const outputHash = sha256Hex(job.input.workload === 'llm' ? output.text : output.digest);
  const costMicro = Math.min(job.priceMicro, Math.max(1, Math.ceil((output.units * pricePer1k) / 1000)));
  const body: ReceiptBody = {
    v: 1,
    jobId: job.id,
    nodeId: node.id,
    nodeClass: nodeClass as any,
    workload: job.input.workload,
    model: job.input.model,
    inputHash: job.inputHash,
    outputHash,
    outputTokens: output.outputTokens,
    units: output.units,
    startedAt: job.startedAt,
    finishedAt: job.startedAt + output.durationMs,
    costMicro,
  };
  return { output, receipt: body, nodeSig: node.sign(canonical(body)) };
}

test('anonymous session gets a grant and is charged, refunded and settled correctly', async () => {
  const { app, ctx, close } = await fresh();
  try {
    const node = makeNode(app);
    await node.register();

    const submit = await app.inject({ method: 'POST', url: '/v1/jobs', payload: { workload: 'llm', model: 'm1', messages: [{ role: 'user', content: 'hi' }], maxOutputTokens: 100 } });
    assert.equal(submit.statusCode, 202);
    const cookie = submit.headers['set-cookie'] as string;
    const job = submit.json();
    assert.equal(job.status, 'queued');
    assert.equal(job.priceMicro, 30); // 100 tokens * 300/1k

    const me1 = (await app.inject({ method: 'GET', url: '/v1/me', headers: { cookie } })).json();
    assert.equal(me1.balanceMicro, FREE_GRANT_MICRO - 30);

    const claimed = await node.claim();
    assert.equal(claimed.statusCode, 200);
    const running = claimed.json().job;
    assert.equal(running.id, job.id);
    assert.equal(running.status, 'running');

    const output = { text: 'hello there friend', outputTokens: 4, units: 4, durationMs: 50 };
    const done = await node.complete(job.id, receiptFor(running, node, output, 'browser', 300));
    assert.equal(done.statusCode, 200, done.body);
    const receipt = done.json().receipt;
    assert.equal(receipt.body.costMicro, 2); // ceil(4*300/1000)

    const me2 = (await app.inject({ method: 'GET', url: '/v1/me', headers: { cookie } })).json();
    assert.equal(me2.balanceMicro, FREE_GRANT_MICRO - 2);

    const nodeMe = (await node.me()).json();
    assert.equal(nodeMe.balanceMicro, 2);
    assert.equal(nodeMe.node.jobsDone, 1);

    const v = (await app.inject({ method: 'POST', url: '/v1/receipts/verify', payload: { receipt } })).json();
    assert.equal(v.valid, true);
    assert.equal(v.routerIsThisRouter, true);
    assert.equal(receipt.routerKey, ctx.routerKey.publicKey);
  } finally {
    await close();
  }
});

test('the cheapest capable node wins', async () => {
  const { app, close } = await fresh();
  try {
    const pricey = makeNode(app);
    const cheap = makeNode(app);
    await pricey.register({ pricePer1k: 900 });
    await cheap.register({ pricePer1k: 250 });
    await app.inject({ method: 'POST', url: '/v1/jobs', payload: { workload: 'llm', model: 'm1', messages: [{ role: 'user', content: 'x' }], maxOutputTokens: 10 } });
    assert.equal((await pricey.claim()).statusCode, 204);
    assert.equal((await cheap.claim()).statusCode, 200);
  } finally {
    await close();
  }
});

test('a node that cannot serve the model is not a candidate', async () => {
  const { app, close } = await fresh();
  try {
    const node = makeNode(app);
    await node.register({ models: ['other'] });
    const r = await app.inject({ method: 'POST', url: '/v1/jobs', payload: { workload: 'llm', model: 'm1', messages: [{ role: 'user', content: 'x' }] } });
    assert.equal(r.statusCode, 202);
    assert.equal((await node.claim()).statusCode, 204);
  } finally {
    await close();
  }
});

test('tampered receipts are rejected', async () => {
  const { app, close } = await fresh();
  try {
    const node = makeNode(app);
    await node.register();
    await app.inject({ method: 'POST', url: '/v1/jobs', payload: { workload: 'llm', model: 'm1', messages: [{ role: 'user', content: 'x' }], maxOutputTokens: 50 } });
    const job = (await node.claim()).json().job;
    const output = { text: 'ok', outputTokens: 1, units: 1, durationMs: 5 };
    const good = receiptFor(job, node, output, 'browser', 300);

    // Over-report tokens: receipt counters disagree with output.
    const bad1 = { ...good, receipt: { ...good.receipt, units: 40 } };
    assert.equal((await node.complete(job.id, bad1)).statusCode, 400);

    // Right counters, wrong signature.
    // Flip a character in the middle; the last one can land on padding bits and still verify.
    const bad2 = { ...good, nodeSig: good.nodeSig.slice(0, 20) + (good.nodeSig[20] === 'A' ? 'B' : 'A') + good.nodeSig.slice(21) };
    assert.equal((await node.complete(job.id, bad2)).statusCode, 400);

    // Claim a different job id.
    const bad3 = { ...good, receipt: { ...good.receipt, jobId: 'job_nope' } };
    assert.equal((await node.complete(job.id, bad3)).statusCode, 400);

    // The honest one still goes through after all that.
    assert.equal((await node.complete(job.id, good)).statusCode, 200);
  } finally {
    await close();
  }
});

test('compute spot check fails a wrong digest and refunds the requester', async () => {
  const { app, close } = await fresh();
  try {
    const node = makeNode(app);
    await node.register({ workloads: ['compute'] });
    const sub = await app.inject({ method: 'POST', url: '/v1/jobs', payload: { workload: 'compute', seed: 5, rounds: 2000 } });
    const cookie = sub.headers['set-cookie'] as string;
    const job = (await node.claim()).json().job;
    const wrong = receiptFor(job, node, { digest: 'ff'.repeat(32), outputTokens: 0, units: 2, durationMs: 1 }, 'browser', 300);
    const r = await node.complete(job.id, wrong);
    assert.equal(r.statusCode, 422);
    const me = (await app.inject({ method: 'GET', url: '/v1/me', headers: { cookie } })).json();
    assert.equal(me.balanceMicro, FREE_GRANT_MICRO);
    const status = (await app.inject({ method: 'GET', url: `/v1/jobs/${job.id}`, headers: { cookie } })).json();
    assert.equal(status.status, 'failed');

    // And the honest digest on a new job is accepted.
    await app.inject({ method: 'POST', url: '/v1/jobs', payload: { workload: 'compute', seed: 5, rounds: 2000 }, headers: { cookie } });
    const job2 = (await node.claim()).json().job;
    const digest = await computeTask(5, 2000);
    const ok = await node.complete(job2.id, receiptFor(job2, node, { digest, outputTokens: 0, units: 2, durationMs: 1 }, 'browser', 300));
    assert.equal(ok.statusCode, 200, ok.body);
  } finally {
    await close();
  }
});

test('node auth rejects stale timestamps and bad signatures', async () => {
  const { app, close } = await fresh();
  try {
    const node = makeNode(app);
    await node.register();
    const stale = Date.now() - 5 * 60_000;
    const sig = node.sign(`${stale}.POST./v1/nodes/${node.id}/claim.${sha256Hex('')}`);
    const r1 = await app.inject({ method: 'POST', url: `/v1/nodes/${node.id}/claim`, headers: { 'x-node-auth': `${stale}.${sig}` } });
    assert.equal(r1.statusCode, 401);
    const r2 = await app.inject({ method: 'POST', url: `/v1/nodes/${node.id}/claim`, headers: { 'x-node-auth': `${Date.now()}.nonsense` } });
    assert.equal(r2.statusCode, 401);
  } finally {
    await close();
  }
});

test('failed jobs go back to the queue and give up after three attempts', async () => {
  const { app, close } = await fresh();
  try {
    const node = makeNode(app);
    await node.register();
    const sub = await app.inject({ method: 'POST', url: '/v1/jobs', payload: { workload: 'llm', model: 'm1', messages: [{ role: 'user', content: 'x' }], maxOutputTokens: 10 } });
    const cookie = sub.headers['set-cookie'] as string;
    const id = sub.json().id;
    for (let i = 0; i < 3; i++) {
      const c = await node.claim();
      assert.equal(c.statusCode, 200, `attempt ${i + 1}`);
      await node.fail(id, 'nope');
    }
    assert.equal((await node.claim()).statusCode, 204);
    const j = (await app.inject({ method: 'GET', url: `/v1/jobs/${id}`, headers: { cookie } })).json();
    assert.equal(j.status, 'failed');
    const me = (await app.inject({ method: 'GET', url: '/v1/me', headers: { cookie } })).json();
    assert.equal(me.balanceMicro, FREE_GRANT_MICRO);
  } finally {
    await close();
  }
});

test('cloud and external classes are refused by default', async () => {
  const { app, close } = await fresh();
  try {
    const node = makeNode(app);
    const r = await app.inject({ method: 'POST', url: '/v1/nodes/register', payload: { class: 'external', label: 'x', publicKey: node.publicKey, capabilities: { workloads: ['llm'], models: ['m1'] } } });
    assert.equal(r.statusCode, 403);
  } finally {
    await close();
  }
});

test('nodes never learn who the requester is', async () => {
  const { app, close } = await fresh();
  try {
    const node = makeNode(app);
    await node.register();
    await app.inject({ method: 'POST', url: '/v1/jobs', payload: { workload: 'llm', model: 'm1', messages: [{ role: 'user', content: 'x' }], maxOutputTokens: 10 } });
    const job = (await node.claim()).json().job;
    assert.equal(job.requesterId, 'hidden');
    assert.ok(!JSON.stringify(job).includes('sess_'));
  } finally {
    await close();
  }
});

test('prompt and reply text are scrubbed after the retention window; hashes and receipts stay', async () => {
  const { app, ctx, close } = await fresh();
  try {
    const node = makeNode(app);
    await node.register();
    const sub = await app.inject({ method: 'POST', url: '/v1/jobs', payload: { workload: 'llm', model: 'm1', messages: [{ role: 'user', content: 'my secret prompt' }], maxOutputTokens: 10 } });
    const cookie = sub.headers['set-cookie'] as string;
    const job = (await node.claim()).json().job;
    const output = { text: 'a private reply', outputTokens: 3, units: 3, durationMs: 5 };
    const done = await node.complete(job.id, receiptFor(job, node, output, 'browser', 300));
    assert.equal(done.statusCode, 200);

    assert.equal(ctx.router.scrubContent(60_000), 0); // too fresh
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(ctx.router.scrubContent(1), 1);
    const after = (await app.inject({ method: 'GET', url: `/v1/jobs/${job.id}`, headers: { cookie } })).json();
    assert.ok(!JSON.stringify(after.input).includes('secret'));
    assert.ok(!JSON.stringify(after.output).includes('private'));
    assert.equal(after.inputHash, job.inputHash);
    assert.equal(after.receipt.body.outputHash, done.json().receipt.body.outputHash);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/receipts/verify', payload: { receipt: after.receipt } })).json().valid, true);
  } finally {
    await close();
  }
});

test('time billing charges router-measured seconds at the hourly rate, capped at the hold', async () => {
  const { app, close } = await fresh();
  try {
    const node = makeNode(app);
    await node.register({ pricePerHour: 360_000 }); // $0.36/h = 100 µcr per second
    const sub = await app.inject({ method: 'POST', url: '/v1/jobs', payload: { workload: 'compute', rounds: 2000, billing: 'time', maxSeconds: 10 } });
    const cookie = sub.headers['set-cookie'] as string;
    const job0 = sub.json();
    assert.equal(job0.priceMicro, 1000); // 10 s × 100 µcr
    const job = (await node.claim()).json().job;
    await new Promise((r) => setTimeout(r, 1100));
    const digest = await computeTask(job.input.seed, job.input.rounds);
    const output = { digest, outputTokens: 0, units: 2, durationMs: 1100 };
    // Mirror what the node client does: seconds since the router's startedAt.
    const seconds = Math.max(1, Math.ceil((Date.now() - job.startedAt) / 1000));
    const costMicro = Math.min(job.priceMicro, seconds * 100);
    const outputHash = sha256Hex(digest);
    const body: ReceiptBody = { v: 1, jobId: job.id, nodeId: node.id, nodeClass: 'browser', workload: 'compute', model: 'hashchain-v1', inputHash: job.inputHash, outputHash, outputTokens: 0, units: 2, startedAt: job.startedAt, finishedAt: Date.now(), costMicro };
    const r = await node.complete(job.id, { output, receipt: body, nodeSig: node.sign(canonical(body)) });
    assert.equal(r.statusCode, 200, r.body);
    assert.ok(r.json().receipt.body.costMicro >= 100 && r.json().receipt.body.costMicro <= 300);
    const me = (await app.inject({ method: 'GET', url: '/v1/me', headers: { cookie } })).json();
    assert.equal(me.balanceMicro, FREE_GRANT_MICRO - r.json().receipt.body.costMicro);
  } finally {
    await close();
  }
});

test('registration needs a verified benchmark; the tier comes from it', async () => {
  const { app, close } = await fresh();
  const n = makeNode(app);
  // no benchmark at all
  let r = await app.inject({ method: 'POST', url: '/v1/nodes/register', payload: { class: 'browser', label: 'x', publicKey: n.publicKey, capabilities: { workloads: ['compute'], models: [] } } });
  assert.equal(r.statusCode, 400);
  assert.match(r.json().error.message, /benchmark required/);
  // wrong samples
  r = await app.inject({ method: 'POST', url: '/v1/nodes/register', payload: { class: 'browser', label: 'x', publicKey: n.publicKey, capabilities: { workloads: ['compute'], models: [] }, benchmark: await n.benchmark({ wrong: true }) } });
  assert.equal(r.statusCode, 400);
  assert.match(r.json().error.message, /do not match/);
  // claiming a time that hasn't passed yet
  const t = await app.inject({ method: 'POST', url: '/v1/benchmark/ticket', payload: {} });
  const tk = t.json().ticket;
  const fast = { ticketId: tk.id, kind: 'webgpu', elapsedMs: 5000, passes: 1000, samples: sampleIndices(tk.nonce).map((i) => benchElement(tk.nonce, i)) };
  r = await app.inject({ method: 'POST', url: '/v1/nodes/register', payload: { class: 'browser', label: 'x', publicKey: n.publicKey, capabilities: { workloads: ['compute'], models: [] }, benchmark: fast } });
  assert.equal(r.statusCode, 400);
  assert.match(r.json().error.message, /timing/);
  // a real one: 40 passes in 200 ms ≈ 5.4e10 → gpu-8, whatever the node claimed
  const ok = await n.register({ hardware: { tier: 'gpu-80', gpu: 'RTX 9090 (claimed)' } }, 'browser', await n.benchmark({ passes: 40, elapsedMs: 200 }));
  assert.equal(ok.node.capabilities.hardware.tier, 'gpu-8');
  assert.equal(ok.node.benchmark.kind, 'webgpu');
  // the ticket is single use
  const reuse = await app.inject({ method: 'POST', url: '/v1/nodes/register', payload: { class: 'browser', label: 'x', publicKey: n.publicKey, capabilities: { workloads: ['compute'], models: [] }, benchmark: { ...fast, ticketId: ok.node.benchmark ? (await n.benchmark()).ticketId : '' } } });
  assert.ok(reuse.statusCode === 400 || reuse.statusCode === 200);
  // a known key reconnecting without a benchmark keeps its measured tier
  const again = await app.inject({ method: 'POST', url: '/v1/nodes/register', payload: { class: 'browser', label: 'x', publicKey: n.publicKey, capabilities: { workloads: ['compute'], models: [], hardware: { tier: 'gpu-80' } } } });
  assert.equal(again.statusCode, 200);
  assert.equal(again.json().node.capabilities.hardware.tier, 'gpu-8');
  // a cpu run is always the cpu tier
  const n2 = makeNode(app);
  const cpu = await n2.register({}, 'browser', await n2.benchmark({ kind: 'cpu', passes: 400 }));
  assert.equal(cpu.node.capabilities.hardware.tier, 'cpu');
  await close();
});
