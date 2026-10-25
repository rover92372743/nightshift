# API

Base path is `/v1`. Everything is JSON. Errors come back as `{"error":{"message":"…","type":"…"}}` with a sensible status.

Three kinds of caller:

| Caller | How it's identified | Gets |
|---|---|---|
| Anonymous session | `nightshift_sid` cookie, set on first request | A small free allowance, rate limited |
| API key | `Authorization: Bearer ns_…` | Whatever balance the operator granted |
| Node | `x-node-auth` signed header (see below) | Its own jobs, earnings and payouts |

Money is always an integer number of micro-credits. One credit is 1,000,000 µcr.

## Inference

### `POST /v1/chat/completions`

OpenAI-compatible. Blocks until the job finishes or 60 seconds pass.

Request:

```json
{
  "model": "qwen2.5-0.5b-instruct",
  "messages": [{"role": "user", "content": "hi"}],
  "max_tokens": 128,
  "temperature": 0.7
}
```

Response: the standard `chat.completion` object with an extra `nightshift` field.

```json
{
  "id": "chatcmpl-…",
  "object": "chat.completion",
  "model": "qwen2.5-0.5b-instruct",
  "choices": [{"index": 0, "message": {"role": "assistant", "content": "…"}, "finish_reason": "stop"}],
  "usage": {"prompt_tokens": 3, "completion_tokens": 41, "total_tokens": 44},
  "nightshift": {
    "job_id": "job_…",
    "node_id": "nd_…",
    "receipt_id": "rcpt_…",
    "cost_micro": 11,
    "duration_ms": 2410
  }
}
```

The web app no longer has a chat page; this endpoint is for your code. Statuses you'll see: `402` not enough credits, `413` prompt too long, `429` rate limited (20 per minute per address by default), `502` the job failed, `504` nothing picked it up in time. On a 504 the job stays queued; you can poll it by `job_id`.

### `POST /v1/jobs`

Same thing without waiting. Returns `202` and the job record. Body is a job input:

```json
{"workload": "llm", "model": "qwen2.5-0.5b-instruct", "messages": [...], "maxOutputTokens": 128}
```

Add `"billing": "time", "maxSeconds": 120` to be billed by the seconds a card holds the job at its hourly rate instead of by output tokens. See [Pricing and credits](/docs/pricing-and-credits).

or

```json
{"workload": "compute", "seed": 7, "rounds": 100000}
```

### `GET /v1/jobs/:id`

The job, including `output` and `receipt` once it's done. Only the requester can read their own jobs.

### `GET /v1/jobs`

Your last 20 jobs.

## Account

### `GET /v1/me`

`{accountId, balanceMicro, ledger: [...]}` for the session or key making the call.

### `POST /v1/access`

`{"company", "email", "need"}` → `{ok: true}`. Asks for a key. Keys are not self-serve: the operator mints one from the console (`keys new`) and sends it to you. Five per hour per address.

### Batches

#### `POST /v1/batches`

`{"items": [JobInput, …], "label": "eval run 3"}` → `202 {id, total, jobIds}`. Up to 500 inputs. The whole batch is held for in one transaction: if your balance can't cover all of it, nothing is queued (`402`).

#### `GET /v1/batches`

Your recent batches with counts.

#### `GET /v1/batches/:id`

`{id, label, total, counts: {queued, assigned, running, done, failed}, costMicro, heldMicro}`.

#### `GET /v1/batches/:id/results[?format=jsonl]`

Every item with its output, units, cost, receipt id. With `format=jsonl` the body is one JSON object per line, as a download.

## Receipts

### `GET /v1/receipts`

The ten most recent receipts on the router. Receipts carry hashes, never content, so this is public.

### `GET /v1/receipts/:id`

By receipt id or job id. Returns `{receipt, valid}` where `valid` is the verifier result.

### `POST /v1/receipts/verify`

`{"receipt": {...}}` → `{valid, nodeSignature, routerSignature, routerIsThisRouter, canonical}`. Checks any receipt you send, whether or not this router issued it.

### `GET /v1/router-key`

`{publicKey, alg: "ed25519"}`. Pin this if you're verifying offline.

## Network

### `GET /v1/network`

`{stats, routerKey}`. Stats include nodes online by class, queue depth, jobs done and failed, verified units, p50/p95 turnaround over the last hour, and the cheapest current llm quote.

### `GET /v1/nodes`, `GET /v1/nodes/:id`

Public view of online nodes: id, class, label, status, capabilities, jobs done. No keys, no earnings.

### `GET /v1/network/live` (WebSocket)

Sends `{"t":"hello", stats, nodes}` on connect, then one message per event, and a `stats` message every four seconds. Event types: `node.up`, `node.down`, `node.busy`, `job.queued`, `job.assigned`, `job.done`, `job.failed`. The web app's map and feed are built on nothing but this.

## Nodes

All node endpoints except `register` need the signed header:

```
x-node-auth: <timestamp_ms>.<signature>
```

where the signature is ed25519 (base64url, detached) over the string

```
<timestamp_ms>.<METHOD>.<path>.<sha256 hex of the raw body, or of "" for no body>
```

Timestamps more than 60 seconds off the router's clock are rejected. The shared package's `NodeClient` does all of this for you.

### `POST /v1/nodes/register`

```json
{
  "class": "browser",
  "label": "chrome on mac",
  "publicKey": "<base64url ed25519 public key>",
  "capabilities": {
    "workloads": ["llm", "compute"],
    "models": ["qwen2.5-0.5b-instruct"],
    "maxPromptChars": 6000,
    "maxOutputTokens": 192,
    "pricePer1k": 250,
    "pricePerHour": 160000,
    "tokensPerSec": 25,
    "hardware": {"gpu": "NVIDIA GeForce RTX 4080", "vramGb": 16, "tier": "gpu-16"}
  }
}
```

Plus, the first time a key registers, a `benchmark` (below). Returns `{node, routerKey}`. Registering again with the same public key is a reconnect; counters, earnings and the measured tier are kept. `cloud` and `external` classes are refused unless `EXTERNAL_ENABLED=true`. Twenty registrations per hour per address.

### `POST /v1/benchmark/ticket`

`{}` → `{ticket: {id, nonce, issuedAt}}`. Ten per hour per address; a ticket lasts ten minutes and can be used once.

### The benchmark

The router sets a node's hardware tier from a measurement, not from what it says about itself. The kernel is integer-only so every implementation produces the same bits:

```
x = nonce ^ i
repeat 256 times: x = x * 1664525 + 1013904223 (mod 2^32); x ^= x >> 13
```

over 2^20 elements, run in passes until about 1.5 seconds have gone by. A browser runs it as a WebGPU compute shader (`BENCH_WGSL` in the shared package) or on the CPU when there is no WebGPU; the agent measures output tokens per second on its model server instead. The registration body then carries:

```json
"benchmark": {
  "ticketId": "bt_…",
  "kind": "webgpu",          // or "cpu", or "tokens" for the agent
  "elapsedMs": 1512,
  "passes": 184,
  "samples": [1793423467, …], // 16 values at indices derived from the nonce
  "gpu": "Apple M2 Max",     // display only
  "tokensPerSec": 41.2        // kind "tokens" only
}
```

The router re-computes the sampled elements, refuses the registration if any differ or if the run claims to have finished before the ticket was issued, burns the ticket, and maps throughput to a tier (`BENCH_TIERS`, `TOKENS_TIERS` in the shared package). `kind: "cpu"` is always the cpu tier.

What it proves: that the work was done. What it does not prove: the elapsed time, which the client reports. A node that overstates its speed only changes its label and default price (routing is by price), and the router keeps an exponential average of real output tokens per second on completed jobs; after ten jobs, if that says a lower tier, the tier comes down.

### `POST /v1/nodes/:id/heartbeat`

`{"busy": false}`. Every ten seconds or so. Thirty-five seconds of silence and the node is marked offline and its jobs go back to the queue.

### `POST /v1/nodes/:id/claim`

Returns `{job}` for a job already assigned to this node, or `204` if there's nothing. The router decides who gets what; claiming only collects it.

### `POST /v1/nodes/:id/jobs/:jobId/complete`

```json
{
  "output": {"text": "…", "outputTokens": 41, "units": 41, "durationMs": 2400},
  "receipt": { ...ReceiptBody },
  "nodeSig": "<signature over canonical(receipt)>"
}
```

Returns `{receipt}` with the router's countersignature added. See [Receipts](/docs/receipts) for what has to be in the body and why the router might say no.

### `POST /v1/nodes/:id/jobs/:jobId/fail`

`{"reason": "…"}`. The job goes back to the queue (up to three attempts) and the node's failure counter goes up.

### `GET /v1/nodes/:id/me`

Everything about your node: record, spendable balance, ledger, recent jobs, payouts.

### `POST /v1/nodes/:id/payouts`

`{"amountMicro": 1000000, "rail": "usdc", "address": "…"}`. See [Payouts and tiers](/docs/payouts-and-tiers).
