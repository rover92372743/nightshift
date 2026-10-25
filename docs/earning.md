# Earning with your hardware

Two ways to run a node. Both earn to a key, both sign a receipt per task, both cash out in SOL or USDC on Solana from $50.

**In a browser tab, nothing to install.** Open the Earn page and press start. In Chrome or Edge on a machine with a graphics card, the tab serves model tasks through WebGPU; elsewhere it serves compute tasks. The model is fetched once and cached by the browser. The node runs as long as the tab is open, keeps going while you browse the rest of the site, and can keep working in the background if you let it. Close the tab and it stops.

**The agent, for machines that should earn all day.** One process on the machine, bigger models through a local model server, keeps going with the lid closed. The rest of this page applies to both.

## What you get paid for

**Tasks, two ways.** A customer's job is billed either by the second your card held it (card-hour billing, the main way businesses buy capacity) or by the output it produced (per-token billing, for small open models). The router measures the seconds on its own clock, from the moment you claimed the job to the moment you completed it. You are paid 80% of the list rate for your hardware class; the other 20% funds verification and the router.

List rates at the time of writing, and what reaches you:

| Hardware class | Typical work | List per card-hour | You receive per card-hour | List per 1M output tokens | You receive per 1M |
|---|---|---|---|---|---|
| CPU only | compute tasks, data prep | $0.03 | $0.024 | — | — |
| GPU up to 8 GB | 1–3B models, embeddings | $0.12 | $0.096 | $0.15 | $0.12 |
| GPU 12–16 GB | 7–8B models, image generation | $0.20 | $0.16 | $0.20 | $0.16 |
| GPU 20–24 GB | 13B models, image and video pipelines | $0.32 | $0.256 | $0.30 | $0.24 |
| GPU 32–48 GB | 30–34B models, LoRA fine-tuning | $0.75 | $0.60 | $0.50 | $0.40 |
| GPU 80 GB+ | 70B models, full fine-tunes | $1.75 | $1.40 | $0.90 | $0.72 |

Concretely: a 16 GB card that is busy for a full hour on card-hour work earns $0.16. A 4090 (24 GB) earns about $0.26 an hour while busy, $6 a day if it is busy around the clock. Whether it is busy depends on customer demand, and the Network page shows the real queue. Nobody is paid for hours that weren't worked.

Why those numbers: hosted APIs serve small open models for a few tenths of a dollar per million tokens, so per-token rates here have to sit near that or nobody buys. Card-hours are where a consumer GPU beats a datacenter: a cloud 24 GB card runs around $1 an hour on demand, so there is room to charge $0.32, pay you $0.26, and still be the cheap option. Check current cloud prices; the gap moves.

**Your class and rate** are set by the agent from your GPU's memory on startup. You can set your own hourly rate (`DOCKET_HOURLY`) or per-1k rate (`DOCKET_PRICE`) above the floor. The router sends each job to the cheapest capable node, so a higher rate means fewer jobs. A browser tab with a GPU is classed as 'up to 8 GB' because browsers only run small models and cannot report memory.

## What you are not paid for

- Being online with no tasks. Card-hour billing starts when you claim a job and stops when you complete it. Idle time is yours. There is no uptime payment on this router unless the operator announces one, in which case it will be labelled as what it is: a launch incentive paid by the operator, not customer revenue.
- Tasks that fail verification. Compute tasks are re-run by the router; a wrong answer is not paid and counts against your node.
- Tasks you decline or that time out. Your lease on a task is 90 seconds; past that it goes back to the queue.

## Tracking it

From the machine running the agent:

```sh
npm run cli            # balance, lifetime, uptime, recent tasks
npm run cli watch      # the same, refreshing
npm run cli payout 50 usdc <solana address>
```

Or open the Earn page and paste the contents of `~/.docket/worker.key` to see the same view in a browser. The key is kept only in that browser.

Both views show the task's kind, status, duration and what it paid. Neither shows task content. The agent processes customer text and does not print it, log it or keep it.

## Cashing out

| Rail | Minimum | What happens |
|---|---|---|
| USDC on Solana | $50 | Balance is debited, a payout is recorded, the operator sends it and attaches the transaction reference |
| SOL | $50 | Same |
| Credits | none | Nothing moves; credits can be spent on inference like any other |

Payouts are settled by the operator, not automatically, until a chain adapter with a funded treasury is configured. Until then your terminal shows the request as `pending` and the reference appears when it's sent. See [Payouts and tiers](/docs/payouts-and-tiers) for what wiring that up involves.

Credits are a unit of account inside the router, one credit is one US dollar for pricing and payout purposes, and nothing here promises a yield.

## Your key is your account

The agent writes an ed25519 key to `~/.docket/worker.key` the first time it runs. Everything you earn is tied to it. Back it up. If you lose it, you lose the balance; there is no account to recover it from, because there is no account. If someone else gets it, they can request your payouts, so treat it like a wallet key.
