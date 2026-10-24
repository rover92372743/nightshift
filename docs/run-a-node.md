# Run a node

A node is anything that can register a public key, poll for work, do it, and sign a receipt. Two are included.

## From a browser tab

Open `/earn`, pick a name and a price, press start. What happens:

1. The page generates an ed25519 key pair the first time and keeps the secret in `localStorage`. The router never sees it. Clear site data and you're a new node with a zero balance, so don't.
2. If "Serve the chat model" is on, a Web Worker loads a small instruct model through transformers.js. WebGPU if the browser has it, CPU otherwise. The download is a few hundred megabytes once; the browser caches the weights.
3. The tab registers, then loops: claim, work, complete, repeat. While the tab is hidden, or the battery is under 20% and not charging, it heartbeats as busy and takes nothing.
4. Leaving the Earn page stops the node. A worker you can't see is a worker you'll forget about.

Earnings and recent jobs refresh every ten seconds from `GET /v1/nodes/:id/me`.

### Setting a price

The price is in micro-credits per thousand output tokens (or per thousand compute units). The floor is 200. The router routes to the cheapest node that can take a job, so a lower price means more work and a higher price means less. There's no clever auction; it's just a sort.

### Size limits

"Max output tokens per job" is a hard cap the router respects when matching. A job asking for more than you allow won't be routed to you. Prompt size is capped at 6,000 characters for browser nodes.

## From a terminal

```sh
DOCKET_URL=http://localhost:8787 npm run worker
```

Environment:

| Variable | Default | Meaning |
|---|---|---|
| `DOCKET_URL` | `http://localhost:8787` | The router |
| `DOCKET_LABEL` | `<hostname> (cli)` | Name on the map |
| `DOCKET_PRICE` | `250` | µcr per 1k units |

The key is kept at `~/.docket/worker.key`. Same rule: lose it, lose the node.

As shipped, the terminal worker serves `compute` only. It's a hundred lines in `apps/api/scripts/headless-worker.mjs` and the interesting part is the `work` function:

```js
async function work(job) {
  const t0 = Date.now();
  if (job.input.workload !== 'compute') throw new Error('this worker only runs compute jobs');
  const digest = await computeTask(job.input.seed, job.input.rounds);
  return { digest, outputTokens: 0, units: Math.ceil(job.input.rounds / 1000), durationMs: Date.now() - t0 };
}
```

### Adding an llm backend

Add `'llm'` to `workloads` and the model names you serve to `models` in the capabilities, then handle `job.input.workload === 'llm'` in `work`. The job gives you `messages`, `maxOutputTokens` and `temperature`; you return `{ text, outputTokens, units: outputTokens, durationMs }`. Anything that produces text works: llama.cpp over HTTP, Ollama, vLLM, a GPU you rent. Report the real token count; the router caps it against the text length anyway.

Model names are free-form strings matched exactly. The browser worker uses `qwen2.5-0.5b-instruct`. If you serve something else, requests have to ask for it by that name.

## Writing your own

Everything a node does goes through `NodeClient` and `runWorker` in `packages/shared/src/node-client.ts`. They're isomorphic: the same code runs in the tab and in Node. You supply a `Signer` (public key plus a `sign(message)` function) and a `work(job)` function. The loop handles registration, heartbeats, claiming, receipt construction, signing, completion, failure reporting, pausing and reconnecting.

If you're in another language, the protocol is in the [API](/docs/api) page. The only fiddly part is the signed header and the canonical JSON, and both are small.

## Things the router will do to you

- Go quiet for 35 seconds and you're marked offline. Any job you held goes back to the queue.
- Hold a job past its 90-second lease and the same happens. Three strikes and the job fails outright with a refund to the requester.
- Return a compute digest that doesn't match and the job fails, your failure count goes up, and you don't get paid for it.
- Sign a receipt that doesn't match what the router recorded and `complete` returns a 400 naming the field.
