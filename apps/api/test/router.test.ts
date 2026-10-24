import { test } from 'node:test';
import assert from 'node:assert/strict';
import nacl from 'tweetnacl';
import { buildApp, buildContext, type Ctx } from '../src/app.js';
import { canonical, computeTask, FREE_GRANT_MICRO, type ReceiptBody } from '@docket/shared';
import { sha256Hex, b64u } from '../src/core/crypto.js';
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Each test gets a throwaway router with an in-memory DB and a fresh key.
async function fresh(): Promise<{ app: FastifyInstance; ctx: Ctx; close: () => Promise<void> }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docket-test-'));
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
    async register(caps: Partial<Record<string, unknown>> = {}, cls = 'browser') {
      const r = await app.inject({
        method: 'POST',
        url: '/v1/nodes/register',
        payload: {
          class: cls,
          label: 'test',
          publicKey,
          capabilities: { workloads: ['llm', 'compute'], models: ['m1'], maxPromptChars: 4000, maxOutputTokens: 256, pricePer1k: 300, ...caps },
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
    const bad2 = { ...good, nodeSig: good.nodeSig.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')) };
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
