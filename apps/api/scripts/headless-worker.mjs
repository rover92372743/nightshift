#!/usr/bin/env node
// The node agent. Runs on a machine with (ideally) a GPU and serves work from
// the router's catalogue.
//
//   NIGHTSHIFT_URL=https://router.example npm run worker
//
// Workloads:
//   compute   always on; the deterministic hash chain, used for spot checks and capacity tests
//   llm       on when NIGHTSHIFT_LLM_URL points at an OpenAI-compatible server on this machine
//             (llama.cpp's llama-server, Ollama, vLLM, LM Studio all qualify)
//
// Environment:
//   NIGHTSHIFT_URL        router, default http://localhost:8787
//   NIGHTSHIFT_LABEL      name on the map, default "<hostname> (gpu)" or "(cli)"
//   NIGHTSHIFT_REGION     optional metro key for the public globe (e.g. toronto, london). Leave unset to stay off the map's pins.
//   NIGHTSHIFT_PRICE      µcr per 1k units; default depends on detected hardware tier
//   NIGHTSHIFT_HOURLY     µcr per hour for time-billed jobs; default depends on tier (1,000,000 = $1)
//   NIGHTSHIFT_LLM_URL    e.g. http://localhost:8080/v1  (llama-server) or http://localhost:11434/v1 (Ollama)
//   NIGHTSHIFT_MODELS     comma-separated model names you serve, as customers will ask for them
//   NIGHTSHIFT_MAX_OUT    max output tokens per task, default 1024
//
// The key lives in ~/.nightshift/worker.key. Customer text is processed and never
// printed, logged or written to disk by this script.

import nacl from 'tweetnacl';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { NodeClient, runWorker, computeTask, tierForVram, TIER_LABEL, HOURLY_SUGGESTED } from '@nightshift/shared';

const baseUrl = process.env.NIGHTSHIFT_URL ?? 'http://localhost:8787';
const llmUrl = process.env.NIGHTSHIFT_LLM_URL?.replace(/\/$/, '');
const models = (process.env.NIGHTSHIFT_MODELS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const maxOut = Number(process.env.NIGHTSHIFT_MAX_OUT ?? 1024);

// --- hardware ---------------------------------------------------------------

function detectGpu() {
  try {
    const out = execFileSync('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], { encoding: 'utf8', timeout: 3000 });
    const [name, mem] = out.trim().split('\n')[0].split(',').map((s) => s.trim());
    return { gpu: name, vramGb: Math.round(Number(mem) / 1024) };
  } catch {
    /* no nvidia-smi */
  }
  if (process.platform === 'darwin') {
    try {
      const out = execFileSync('system_profiler', ['SPDisplaysDataType'], { encoding: 'utf8', timeout: 5000 });
      const chip = out.match(/Chipset Model:\s*(.+)/)?.[1]?.trim();
      // Apple silicon shares memory; report total RAM as usable VRAM, which is roughly right.
      if (chip?.includes('Apple')) return { gpu: chip, vramGb: Math.round(os.totalmem() / 2 ** 30) };
    } catch {
      /* ignore */
    }
  }
  return { gpu: undefined, vramGb: undefined };
}

const hw = detectGpu();
const tier = tierForVram(hw.vramGb);
// Suggested prices per tier, µcr per 1k units. Operators can override.
const SUGGESTED = { cpu: 250, 'gpu-8': 400, 'gpu-16': 600, 'gpu-24': 900, 'gpu-48': 1500, 'gpu-80': 2600 };
const price = Number(process.env.NIGHTSHIFT_PRICE ?? SUGGESTED[tier]);
const hourly = Number(process.env.NIGHTSHIFT_HOURLY ?? HOURLY_SUGGESTED[tier]);
const label = process.env.NIGHTSHIFT_LABEL ?? `${os.hostname()} (${hw.gpu ? 'gpu' : 'cli'})`;

// --- key --------------------------------------------------------------------

const keyFile = process.env.NIGHTSHIFT_KEYFILE ?? path.join(os.homedir(), '.nightshift', 'worker.key');
let kp;
if (fs.existsSync(keyFile)) {
  kp = nacl.sign.keyPair.fromSecretKey(Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'base64url'));
} else {
  kp = nacl.sign.keyPair();
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  fs.writeFileSync(keyFile, Buffer.from(kp.secretKey).toString('base64url'), { mode: 0o600 });
  console.log(`new node key written to ${keyFile} — back it up; it is your earnings account`);
}
const signer = {
  publicKey: Buffer.from(kp.publicKey).toString('base64url'),
  sign: (msg) => Buffer.from(nacl.sign.detached(new TextEncoder().encode(msg), kp.secretKey)).toString('base64url'),
};

// --- llm backend ------------------------------------------------------------

let llmOk = false;
if (llmUrl) {
  try {
    const r = await fetch(`${llmUrl}/models`);
    llmOk = r.ok;
    if (!llmOk) console.log(`llm backend at ${llmUrl} answered ${r.status}; serving compute only`);
    if (llmOk && models.length === 0) console.log('NIGHTSHIFT_LLM_URL is set but NIGHTSHIFT_MODELS is empty; set the model names customers will ask for');
  } catch (e) {
    console.log(`llm backend at ${llmUrl} unreachable (${e.message}); serving compute only`);
  }
}
const workloads = llmOk && models.length ? ['llm', 'compute'] : ['compute'];

async function runLlm(job) {
  const t0 = Date.now();
  const r = await fetch(`${llmUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: job.input.model, messages: job.input.messages, max_tokens: Math.min(job.input.maxOutputTokens ?? 256, maxOut), temperature: job.input.temperature ?? 0.7 }),
  });
  if (!r.ok) throw new Error(`backend ${r.status}`);
  const data = await r.json();
  const text = data.choices?.[0]?.message?.content ?? '';
  const outputTokens = data.usage?.completion_tokens ?? Math.ceil(text.length / 4);
  return { text, outputTokens, units: outputTokens, durationMs: Date.now() - t0 };
}

async function work(job) {
  if (job.input.workload === 'llm') return runLlm(job);
  const t0 = Date.now();
  const digest = await computeTask(job.input.seed, job.input.rounds);
  return { digest, outputTokens: 0, units: Math.ceil(job.input.rounds / 1000), durationMs: Date.now() - t0 };
}

// --- go ---------------------------------------------------------------------

const client = new NodeClient({
  baseUrl,
  signer,
  class: 'native',
  label,
  capabilities: { workloads, models: workloads.includes('llm') ? models : [], maxPromptChars: 16000, maxOutputTokens: maxOut, pricePer1k: price, pricePerHour: hourly, tokensPerSec: hw.gpu ? 40 : 8, hardware: { ...hw, tier }, region: process.env.NIGHTSHIFT_REGION || undefined },
});

console.log(`hardware: ${hw.gpu ?? 'no GPU detected'}${hw.vramGb ? ` (${hw.vramGb} GB)` : ''} → ${TIER_LABEL[tier]}, $${(hourly / 1e6).toFixed(2)}/h, ${price} µcr/1k, workloads: ${workloads.join(', ')}`);

const ctrl = new AbortController();
process.on('SIGINT', () => ctrl.abort());

await runWorker(
  client,
  work,
  {
    status: (s, d) => console.log(`[${new Date().toISOString()}] ${s}${s === 'working' ? ' ' + d : s === 'error' ? ' ' + d : ''}`),
    done: (j, r) => console.log(`  done ${j.id} · ${r.body.units} units · $${(r.body.costMicro / 1e6).toFixed(6)} · receipt ${r.id}`),
    failed: (j, why) => console.log(`  failed ${j.id}: ${why}`),
  },
  { signal: ctrl.signal },
);
