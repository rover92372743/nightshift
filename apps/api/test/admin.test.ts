import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp, buildContext } from '../src/app.js';
import { config } from '../src/config.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('admin routes: off without a key, then grant + keys + accounts with one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightshift-admin-'));
  const ctx = buildContext({ dbPath: ':memory:', keyPath: path.join(dir, 'router.key') });
  const app = await buildApp(ctx);
  await app.ready();
  // no key configured → 404
  config.adminKey = '';
  let r = await app.inject({ method: 'GET', url: '/v1/admin/accounts', headers: { 'x-admin-key': 'x' } });
  assert.equal(r.statusCode, 404);

  config.adminKey = 'secret-test-key';
  r = await app.inject({ method: 'GET', url: '/v1/admin/accounts', headers: { 'x-admin-key': 'wrong' } });
  assert.equal(r.statusCode, 401);

  r = await app.inject({ method: 'POST', url: '/v1/admin/keys', headers: { 'x-admin-key': 'secret-test-key' }, payload: { label: 'Acme', credits: 25 } });
  assert.equal(r.statusCode, 200);
  const k = r.json();
  assert.equal(k.balanceMicro, 25_000_000);
  assert.match(k.apiKey, /^ns_/);

  r = await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${k.apiKey}` } });
  assert.equal(r.json().label, 'Acme');
  assert.equal(r.json().balanceMicro, 25_000_000);

  r = await app.inject({ method: 'POST', url: '/v1/admin/grant', headers: { 'x-admin-key': 'secret-test-key' }, payload: { accountId: k.accountId, credits: -5, note: 'clawback' } });
  assert.equal(r.json().balanceMicro, 20_000_000);

  r = await app.inject({ method: 'GET', url: '/v1/admin/accounts', headers: { 'x-admin-key': 'secret-test-key' } });
  const acct = r.json().accounts.find((a: { id: string }) => a.id === k.accountId);
  assert.equal(acct.balanceMicro, 20_000_000);
  assert.equal(acct.label, 'Acme');

  r = await app.inject({ method: 'POST', url: '/v1/admin/grant', headers: { 'x-admin-key': 'secret-test-key' }, payload: { accountId: 'acct_nope', credits: 1 } });
  assert.equal(r.statusCode, 404);
  await app.close();
  ctx.db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('payouts: USDC only, $15 minimum on balance and amount, debited on request, reviewed by the operator', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightshift-payout-'));
  const ctx = buildContext({ dbPath: ':memory:', keyPath: path.join(dir, 'router.key') });
  const app = await buildApp(ctx);
  await app.ready();
  config.adminKey = 'secret-test-key';
  const admin = { 'x-admin-key': 'secret-test-key' };
  const ADDR = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';

  // a node account with some earnings
  const acct = ctx.ledger.ensureNodeAccount('nd_test');
  ctx.db.prepare("INSERT INTO nodes (id, account_id, class, label, public_key, capabilities, status, last_seen, created_at, earned_micro, jobs_done) VALUES ('nd_test', ?, 'native', 'rig', 'pk_test', '{}', 'online', 0, 0, 40000000, 12)").run(acct);
  ctx.ledger.post(acct, 10_000_000, 'earn', 'j1');
  assert.throws(() => ctx.payouts.request(acct, 10_000_000, ADDR), /below the minimum/);
  ctx.ledger.post(acct, 30_000_000, 'earn', 'j2'); // balance $40
  assert.throws(() => ctx.payouts.request(acct, 5_000_000, ADDR), /minimum payout/);
  assert.throws(() => ctx.payouts.request(acct, 20_000_000, 'not-an-address'), /Solana/);
  assert.throws(() => ctx.payouts.request(acct, 50_000_000, ADDR), /exceeds/);
  const p = ctx.payouts.request(acct, 20_000_000, ADDR);
  assert.equal(p.status, 'pending');
  assert.equal(ctx.ledger.balance(acct), 20_000_000, 'debited at request time');
  assert.throws(() => ctx.payouts.request(acct, 15_000_000, ADDR), /already waiting/);

  // the operator sees it with the requester's balance and address
  let r = await app.inject({ method: 'GET', url: '/v1/admin/payouts', headers: admin });
  const row = r.json().payouts[0];
  assert.equal(row.id, p.id);
  assert.equal(row.address, ADDR);
  assert.equal(row.nodeLabel, 'rig');
  assert.equal(row.balanceMicro, 20_000_000);
  assert.equal(row.earnedMicro, 40_000_000);

  // approve needs a tx reference
  r = await app.inject({ method: 'POST', url: `/v1/admin/payouts/${p.id}/approve`, headers: admin, payload: { txRef: 'x' } });
  assert.equal(r.statusCode, 400);
  r = await app.inject({ method: 'POST', url: `/v1/admin/payouts/${p.id}/approve`, headers: admin, payload: { txRef: '5UfDuX3q7wbQ…signature' } });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().payout.status, 'sent');
  assert.equal(ctx.ledger.balance(acct), 20_000_000, 'credits stay debited once sent');

  // a second request, rejected: credits come back
  const p2 = ctx.payouts.request(acct, 15_000_000, ADDR);
  r = await app.inject({ method: 'POST', url: `/v1/admin/payouts/${p2.id}/reject`, headers: admin, payload: { reason: 'address mismatch' } });
  assert.equal(r.json().payout.status, 'rejected');
  assert.equal(ctx.ledger.balance(acct), 20_000_000);
  r = await app.inject({ method: 'POST', url: `/v1/admin/payouts/${p2.id}/reject`, headers: admin, payload: {} });
  assert.equal(r.statusCode, 400, 'cannot reject twice');

  await app.close();
  ctx.db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
