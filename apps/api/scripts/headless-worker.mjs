#!/usr/bin/env node
// A native node that serves the `compute` workload from a terminal.
//
//   DOCKET_URL=http://localhost:8787 npm run worker
//
// Keeps its key in ~/.docket/worker.key so earnings survive restarts. Add an
// llm backend by implementing `work` for job.input.workload === 'llm'.

import nacl from 'tweetnacl';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NodeClient, runWorker, computeTask } from '@docket/shared';

const baseUrl = process.env.DOCKET_URL ?? 'http://localhost:8787';
const label = process.env.DOCKET_LABEL ?? `${os.hostname()} (cli)`;
const price = Number(process.env.DOCKET_PRICE ?? 250);

const keyFile = path.join(os.homedir(), '.docket', 'worker.key');
let kp;
if (fs.existsSync(keyFile)) {
  kp = nacl.sign.keyPair.fromSecretKey(Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'base64url'));
} else {
  kp = nacl.sign.keyPair();
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  fs.writeFileSync(keyFile, Buffer.from(kp.secretKey).toString('base64url'), { mode: 0o600 });
  console.log(`new worker key written to ${keyFile}`);
}

const signer = {
  publicKey: Buffer.from(kp.publicKey).toString('base64url'),
  sign: (msg) => Buffer.from(nacl.sign.detached(new TextEncoder().encode(msg), kp.secretKey)).toString('base64url'),
};

const client = new NodeClient({
  baseUrl,
  signer,
  class: 'native',
  label,
  capabilities: {
    workloads: ['compute'],
    models: [],
    maxPromptChars: 4000,
    maxOutputTokens: 256,
    pricePer1k: price,
    tokensPerSec: 50,
  },
});

async function work(job) {
  const t0 = Date.now();
  if (job.input.workload !== 'compute') throw new Error('this worker only runs compute jobs');
  const digest = await computeTask(job.input.seed, job.input.rounds);
  const units = Math.ceil(job.input.rounds / 1000);
  return { digest, outputTokens: 0, units, durationMs: Date.now() - t0 };
}

const ctrl = new AbortController();
process.on('SIGINT', () => ctrl.abort());

await runWorker(
  client,
  work,
  {
    status: (s, d) => console.log(`[${new Date().toISOString()}] ${s}${d ? ' ' + d : ''}`),
    done: (j, r) => console.log(`  done ${j.id} -> receipt ${r.id}, ${r.body.units} units, ${r.body.costMicro} µcr`),
    failed: (j, why) => console.log(`  failed ${j.id}: ${why}`),
  },
  { signal: ctrl.signal },
);
