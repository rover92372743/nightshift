# nightshift-agent

Run a Nightshift node from a terminal. Your machine takes tasks from businesses on the network, does the work, signs a receipt for each one, and is paid per task in USDC on Solana.

Needs Node 20 or newer.

```sh
NIGHTSHIFT_URL=https://api.nightshift.host npx nightshift-agent
```

The first run creates a key at `~/.nightshift/worker.key`. That key is your account: back it up, and don't share it. The first run also measures the machine (a few seconds) so the router can set your hardware tier.

## Serving model tasks

Compute tasks run anywhere. To also serve model tasks, run an OpenAI-compatible model server on the same machine (Ollama, llama.cpp's `llama-server`, vLLM, LM Studio) and tell the agent where it is and which models it serves:

```sh
NIGHTSHIFT_URL=https://api.nightshift.host \
NIGHTSHIFT_LLM_URL=http://localhost:11434/v1 \
NIGHTSHIFT_MODELS=qwen2.5-7b-instruct \
npx nightshift-agent
```

## Settings

| Variable | Default | What it does |
|---|---|---|
| `NIGHTSHIFT_URL` | `http://localhost:8787` | The router |
| `NIGHTSHIFT_LABEL` | hostname | Name shown on the map |
| `NIGHTSHIFT_REGION` | unset | Metro key for the globe, e.g. `toronto`, `london`, `tokyo` |
| `NIGHTSHIFT_PRICE` | by tier | Your price per 1k output tokens or work units, in micro-credits (1,000,000 = $1) |
| `NIGHTSHIFT_HOURLY` | by tier | Your price per card-hour, in micro-credits |
| `NIGHTSHIFT_LLM_URL` | unset | OpenAI-compatible server on this machine |
| `NIGHTSHIFT_MODELS` | unset | Comma-separated model names you serve |
| `NIGHTSHIFT_MAX_OUT` | `1024` | Max output tokens per task |
| `NIGHTSHIFT_REBENCH` | unset | `1` to measure the machine again |

Prices can't go below the floor for your measured tier; the router raises them if they do.

## Watching earnings

```sh
NIGHTSHIFT_URL=https://api.nightshift.host npx nightshift status
NIGHTSHIFT_URL=https://api.nightshift.host npx nightshift earnings
NIGHTSHIFT_URL=https://api.nightshift.host npx nightshift payout 20 <your solana address>
```

The Earn page on the site shows the same thing for the key in your browser.

## What the agent sees

Task content is processed and forgotten. The agent never writes prompts or outputs to disk, and the receipt it signs carries hashes, not text.
