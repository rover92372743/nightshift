# Run a node

A node is anything that can register a public key, poll for work, do it, and sign a receipt. Two are included.

## Measure first

Every new key runs a short benchmark before the router will register it: about two seconds on the GPU through WebGPU (or the CPU when the browser has none), checked by the router, which sets the hardware tier and the default hourly price from the result. The agent does the same with a short generation on its model server. A key the router has measured once can come back without repeating it; "Measure again" on the Earn page, or `NIGHTSHIFT_REBENCH=1` for the agent, re-runs it after a hardware change. Real job timings keep the tier honest afterwards. Details in the [API](/docs/api) page.

## From a browser tab

The Earn page starts a node inside the tab with nothing to install. With WebGPU (Chrome, Edge) and a graphics card it serves model tasks with a small instruct model; otherwise compute tasks. It keeps running while you move around the site, pauses on low battery, and optionally keeps working while the tab is in the background. Closing the tab stops it. The key lives in the browser's local storage, so clearing site data starts you over with a new node.

Browsers throttle hidden tabs, so background earning is slower than foreground. For a machine that should earn around the clock, run the agent.

## From a terminal

```sh
NIGHTSHIFT_URL=http://localhost:8787 npm run worker
```

Environment:

| Variable | Default | Meaning |
|---|---|---|
| `NIGHTSHIFT_URL` | `http://localhost:8787` | The router |
| `NIGHTSHIFT_LABEL` | `<hostname> (gpu)` or `(cli)` | Name on the map. Pick something that doesn't identify you |
| `NIGHTSHIFT_REGION` | unset | Optional metro key (`toronto`, `london`, `tokyo`…) so the globe can pin you. Coarse by design; see privacy |
| `NIGHTSHIFT_PRICE` | by hardware class | µcr per 1k units for token-billed jobs. Floor is 200 |
| `NIGHTSHIFT_HOURLY` | by hardware class | µcr per hour for time-billed jobs (1,000,000 = $1). Floor is 10,000 |
| `NIGHTSHIFT_LLM_URL` | unset | An OpenAI-compatible server on this machine, e.g. `http://localhost:8080/v1` |
| `NIGHTSHIFT_MODELS` | unset | Comma-separated model names you serve, as customers will ask for them |
| `NIGHTSHIFT_MAX_OUT` | `1024` | Max output tokens per task |

On startup the agent runs `nvidia-smi` (or `system_profiler` on a Mac) to find the GPU and its memory, assigns a hardware class, and picks the suggested price for that class unless you set one. The class and price are visible on the map and in `npm run cli`.

The key is kept at `~/.nightshift/worker.key`. Same rule: lose it, lose the node.

### Serving model tasks

Run any OpenAI-compatible server locally and point the agent at it:

```sh
# llama.cpp
llama-server -m qwen2.5-7b-instruct-q4_k_m.gguf --port 8080
NIGHTSHIFT_LLM_URL=http://localhost:8080/v1 NIGHTSHIFT_MODELS=qwen2.5-7b-instruct npm run worker

# Ollama
ollama serve
NIGHTSHIFT_LLM_URL=http://localhost:11434/v1 NIGHTSHIFT_MODELS=llama3.1:8b npm run worker
```

The agent checks the server answers before advertising `llm`. Model names are free-form strings matched exactly; customers have to ask for the name you list.

### Customer data

The agent sends task text to your local model server and returns the result. It does not print, log or write that text anywhere, and the earnings views never show it. Your model server may log requests; check its settings if that matters to you. See [Privacy](/docs/privacy).

The compute path is the `work` function in `apps/api/scripts/headless-worker.mjs`:

```js
async function work(job) {
  const t0 = Date.now();
  if (job.input.workload !== 'compute') throw new Error('this worker only runs compute jobs');
  const digest = await computeTask(job.input.seed, job.input.rounds);
  return { digest, outputTokens: 0, units: Math.ceil(job.input.rounds / 1000), durationMs: Date.now() - t0 };
}
```

## Writing your own

Everything a node does goes through `NodeClient` and `runWorker` in `packages/shared/src/node-client.ts`. They're isomorphic: the same code runs in the tab and in Node. You supply a `Signer` (public key plus a `sign(message)` function) and a `work(job)` function. The loop handles registration, heartbeats, claiming, receipt construction, signing, completion, failure reporting, pausing and reconnecting.

If you're in another language, the protocol is in the [API](/docs/api) page. The only fiddly part is the signed header and the canonical JSON, and both are small.

## Things the router will do to you

- Go quiet for 35 seconds and you're marked offline. Any job you held goes back to the queue.
- Hold a job past its 90-second lease and the same happens. Three strikes and the job fails outright with a refund to the requester.
- Return a compute digest that doesn't match and the job fails, your failure count goes up, and you don't get paid for it.
- Sign a receipt that doesn't match what the router recorded and `complete` returns a 400 naming the field.
- Claim a hardware tier your measured throughput doesn't support and, after ten jobs, the router lowers it.
