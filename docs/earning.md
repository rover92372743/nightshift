# Earning with your hardware

You run the agent. It takes tasks from businesses using the network, signs a receipt for each one, and credits your balance. When your balance reaches $50 you can cash out in SOL or USDC on Solana.

## What you get paid for

**Tasks.** Each task pays by its size (output tokens for model work, work units for compute) at the rate for your hardware class. Rates are set by the router operator and published on the Pricing page; node operators receive 80% of the list rate. The other 20% funds verification and the router.

The list rates at the time of writing, with the operator share:

| Hardware class | Typical work | List rate per 1k | You receive per 1k |
|---|---|---|---|
| CPU only | compute tasks, tiny models | $0.0004 | $0.00032 |
| GPU up to 8 GB | 1–3B models, embeddings | $0.0008 | $0.00064 |
| GPU 12–16 GB | 7–8B models, image generation | $0.0014 | $0.00112 |
| GPU 20–24 GB | 13B models, quantised 30B | $0.0022 | $0.00176 |
| GPU 32–48 GB | 30–34B models | $0.0040 | $0.0032 |
| GPU 80 GB+ | 70B models, long contexts | $0.0070 | $0.0056 |

To make that concrete: a 16 GB card serving 7B-model tasks that average 300 output tokens earns about $0.00034 per task. At one task every ten seconds, that's about $0.12 an hour, $2.90 a day, if the work is there. Whether the work is there depends entirely on customer demand, and the Network page shows the real queue. Nobody is paid for tasks that didn't run.

**The agent chooses the class** by detecting your GPU and its memory on startup. You can set your own price above the class floor with `DOCKET_PRICE`; the router routes to the cheapest capable node, so a higher price means fewer tasks.

## What you are not paid for

- Being online with no tasks. There is no uptime payment on this router unless the operator announces one, in which case it will be labelled as what it is: a launch incentive paid by the operator, not customer revenue.
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
