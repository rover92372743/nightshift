#!/usr/bin/env node
// Operator tool: add credits to an account.
//
//   node apps/api/scripts/grant.mjs <accountId> <credits> [note]
//
// Writes straight to the ledger, so stop the API first or accept that the
// next request will see the new balance only once SQLite's WAL settles
// (which is immediate in practice).

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const [accountId, creditsRaw, note = 'operator grant'] = process.argv.slice(2);
if (!accountId || !creditsRaw) {
  console.error('usage: grant.mjs <accountId> <credits> [note]');
  process.exit(1);
}
const micro = Math.round(Number(creditsRaw) * 1_000_000);
if (!Number.isFinite(micro) || micro <= 0) {
  console.error('credits must be a positive number');
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DOCKET_DB ?? path.resolve(here, '../../../data/docket.db');
const db = new Database(dbPath);

const acct = db.prepare('SELECT id, kind, label FROM accounts WHERE id = ?').get(accountId);
if (!acct) {
  console.error(`no account ${accountId}`);
  process.exit(1);
}
db.prepare('INSERT INTO ledger (id, account_id, delta_micro, kind, ref, created_at) VALUES (?,?,?,?,?,?)').run(
  'lg_' + randomBytes(9).toString('base64url'),
  accountId,
  micro,
  'grant',
  note,
  Date.now(),
);
const bal = db.prepare('SELECT COALESCE(SUM(delta_micro),0) AS b FROM ledger WHERE account_id = ?').get(accountId).b;
console.log(`granted ${creditsRaw} cr to ${acct.kind} "${acct.label}" (${accountId}); balance now ${(bal / 1e6).toFixed(4)} cr`);
