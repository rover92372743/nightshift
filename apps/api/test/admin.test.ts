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
