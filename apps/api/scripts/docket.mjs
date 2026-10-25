#!/usr/bin/env node
// Node operator CLI: a terminal view of what your key has earned.
//
//   docket status                 what the router knows about this node
//   docket earnings               balance, lifetime, uptime, recent jobs
//   docket watch                  the same, refreshing every few seconds
//   docket payout <amount> <rail> [address]   e.g. docket payout 50 usdc 7xK...
//   docket key                    print this node's public key
//
// Uses the key in ~/.docket/worker.key (the same one the worker uses), so
// the router answers only for the node you actually run. Set DOCKET_URL to
// point at a router other than localhost.

import nacl from 'tweetnacl';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NodeClient, PAYOUT_MIN_MICRO, TIER_LABEL } from '@docket/shared';

const baseUrl = process.env.DOCKET_URL ?? 'http://localhost:8787';
const keyFile = process.env.DOCKET_KEYFILE ?? path.join(os.homedir(), '.docket', 'worker.key');
const [cmd = 'earnings', ...args] = process.argv.slice(2);

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const blue = (s) => `\x1b[34m${s}\x1b[0m`;
const cr = (micro) => (micro / 1e6).toFixed(micro < 100_000 ? 6 : 2);
const usd = (micro) => `$${(micro / 1e6).toFixed(2)}`;
const hm = (ms) => `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000).toString().padStart(2, '0')}m`;
const when = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

if (!fs.existsSync(keyFile)) {
  console.error(`No key at ${keyFile}. Run the worker once (npm run worker) to create one.`);
  process.exit(1);
}
const kp = nacl.sign.keyPair.fromSecretKey(Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'base64url'));
const signer = {
  publicKey: Buffer.from(kp.publicKey).toString('base64url'),
  sign: (msg) => Buffer.from(nacl.sign.detached(new TextEncoder().encode(msg), kp.secretKey)).toString('base64url'),
};

// The router identifies nodes by public key. lookupOnly asks for the node id
// without changing the worker's label, price or capabilities.
async function connect() {
  const client = new NodeClient({
    baseUrl,
    signer,
    class: 'native',
    label: process.env.DOCKET_LABEL ?? `${os.hostname()} (cli)`,
    capabilities: { workloads: ['compute'], models: [], maxPromptChars: 4000, maxOutputTokens: 256, pricePer1k: 250 },
    lookupOnly: true,
  });
  await client.register();
  return client;
}

function render(me) {
  const n = me.node;
  const hw = n.capabilities.hardware;
  const lines = [
    `${bold('Docket')} ${dim(baseUrl)}`,
    '',
    `${dim('node')}      ${n.label}  ${dim(n.id)}`,
    `${dim('status')}    ${n.status === 'offline' ? 'offline' : green(n.status)}`,
    `${dim('hardware')}  ${hw?.gpu ?? 'not reported'}${hw?.vramGb ? `, ${hw.vramGb} GB` : ''}${hw?.tier ? dim(`  (${TIER_LABEL[hw.tier]})`) : ''}`,
    `${dim('price')}     $${((n.capabilities.pricePerHour ?? 0) / 1e6).toFixed(2)} per hour · $${(n.capabilities.pricePer1k / 1000).toFixed(2)} per 1M tokens`,
    `${dim('uptime')}    ${hm(me.uptimeMs24h)} today`,
    '',
    `${dim('balance')}   ${bold(usd(me.balanceMicro))}  ${dim(`(${cr(me.balanceMicro)} cr, spendable or payable)`)}`,
    `${dim('lifetime')}  ${usd(n.earnedMicro)} across ${n.jobsDone} task${n.jobsDone === 1 ? '' : 's'}, ${n.unitsVerified} units verified, ${n.jobsFailed} failed`,
    `${dim('payout')}    ${me.balanceMicro >= me.payoutMinMicro ? green(`eligible (minimum ${usd(me.payoutMinMicro)})`) : `${usd(me.payoutMinMicro - me.balanceMicro)} to go before SOL/USDC payout`}`,
  ];
  if (me.payouts?.length) {
    lines.push('', bold('Payouts'));
    for (const p of me.payouts.slice(0, 5)) lines.push(`  ${when(p.createdAt)}  ${usd(p.amountMicro).padStart(9)}  ${p.rail.padEnd(7)} ${p.status}${p.txRef ? dim('  ' + p.txRef) : ''}`);
  }
  lines.push('', bold('Recent tasks'));
  if (!me.jobs.length) lines.push(dim('  none yet'));
  for (const j of me.jobs.slice(0, 10)) {
    const cost = j.costMicro ? usd(j.costMicro) : '';
    const took = j.output?.durationMs ? `${(j.output.durationMs / 1000).toFixed(1)}s` : '';
    lines.push(`  ${when(j.createdAt)}  ${j.input.workload.padEnd(8)} ${j.status.padEnd(9)} ${took.padStart(6)}  ${cost.padStart(9)}`);
  }
  lines.push('', dim('Task content is never shown here. You run the work; you do not see the customer’s data.'));
  return lines.join('\n');
}

const client = await connect();

if (cmd === 'key') {
  console.log(signer.publicKey);
} else if (cmd === 'status' || cmd === 'earnings') {
  console.log(render(await client.me()));
} else if (cmd === 'watch') {
  const tick = async () => {
    try {
      process.stdout.write('\x1b[2J\x1b[H' + render(await client.me()) + '\n\n' + dim(`refreshing · ${new Date().toLocaleTimeString()} · ctrl-c to stop`) + '\n');
    } catch (e) {
      process.stdout.write(`\n${dim('router unreachable: ' + e.message)}\n`);
    }
  };
  await tick();
  setInterval(tick, 5000);
} else if (cmd === 'payout') {
  const [amount, rail = 'usdc', address] = args;
  const micro = Math.round(Number(amount) * 1e6);
  if (!micro || !['credits', 'usdc', 'sol'].includes(rail)) {
    console.error('usage: docket payout <amount> <credits|usdc|sol> [solana address]');
    process.exit(1);
  }
  if (rail !== 'credits' && micro < PAYOUT_MIN_MICRO) {
    console.error(`Minimum payout is $${PAYOUT_MIN_MICRO / 1e6}.`);
    process.exit(1);
  }
  try {
    const p = await client.requestPayout(micro, rail, address);
    console.log(`${p.status === 'sent' ? green('sent') : blue(p.status)}  ${usd(p.amountMicro)} via ${p.rail}  ${dim(p.id)}`);
    if (p.status === 'pending') console.log(dim('Pending payouts are settled by the operator; this will show a transaction reference once it goes out.'));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
} else {
  console.log('commands: status, earnings, watch, payout <amount> <rail> [address], key');
}
