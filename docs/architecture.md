# Architecture

One Node process, one SQLite file, one WebSocket. The web app is static files that talk to it.

```
apps/web  ──HTTP /v1──▶  apps/api (Fastify)  ──▶  SQLite (data/nightshift.db)
          ◀──WS /v1/network/live──┘
                                  ▲
nodes (browser tab, cli) ──signed HTTP──┘
```

## Job lifecycle

```
queued ──assign──▶ assigned ──claim──▶ running ──complete──▶ done
   ▲                  │                   │
   └────lease expired / node offline / fail (≤3 attempts)────┘
                                                        └──▶ failed (refund)
```

**Enqueue** (`Router.enqueue`). Validate the input, hash it, estimate units, quote against the cheapest candidate, hold the quote on the requester's ledger, insert the job, emit `job.queued`, then try to dispatch.

**Dispatch** (`Router.dispatch`). Walk the queue oldest-first. For each job, find candidates: online, status `online` (not busy), serves the workload, serves the model, prompt and output within the node's caps. Sort by price ascending, then claimed throughput descending, then how long since the node was last seen. Assign to the first, mark it busy, set a 90-second lease, emit `job.assigned`. Dispatch runs on enqueue, on every idle heartbeat and claim, after every completion, and on the housekeeping timer.

**Claim** (`Router.claim`). The node asks for its work. It gets the oldest job assigned to it, which flips to `running` with a fresh lease. The point of this split is that "who does the job" is a router decision, not a race between nodes polling the queue.

**Complete** (`Router.complete`). The checks in [Receipts](/docs/receipts), then one transaction: job to `done`, refund the unused hold, credit the node, bump the node's counters, store the receipt. Emit `job.done`. Dispatch again.

**Reaping.** Every five seconds: nodes silent for 35 seconds go offline and their jobs are released; jobs past their lease are released. A released job goes back to `queued` unless it has already had three attempts, in which case it fails and the hold is refunded.

## Why nodes pull

Browser tabs can't accept inbound connections, and a native worker behind NAT shouldn't have to. So nodes poll. The cost is latency (a tab polls every 1.5 s when idle), which is fine for a system whose jobs take seconds. The benefit is that a node that disappears just stops polling, and the lease handles the rest.

## Why the node signs requests

The alternative is a bearer token per node. That means a secret in the database that, if leaked, lets someone impersonate every node. With per-request signatures the router stores only public keys. A compromised router database gets an attacker nothing they can use to sign a receipt.

The header is `x-node-auth: <ts>.<sig>` with the signature over `ts.METHOD.path.sha256(body)`. The raw body is hashed, not a re-serialisation, so the router keeps the raw string around (`app.ts` installs a content-type parser for that). Timestamps outside a 60-second window are rejected, which bounds replay.

## Why SQLite

Because it's one file, it's transactional, and a single router process is the right shape for this. `better-sqlite3` is synchronous, which makes the transactional bits (`charge`, `complete`) easy to get right. WAL mode is on. If you outgrow it, the queries are plain SQL in four files and nothing depends on SQLite-specific behaviour beyond `json_extract` in one stats query.

## The live feed

`core/live.ts` is an in-process event bus with ten lines of code. The router emits into it; the WebSocket route subscribes each connection. There's no fan-out layer because there's one process. If you run two, the feed is per-process and you'd add something like Redis pub/sub between them.

## The web app

No framework. `main.ts` is a History-API router with seven routes; each page is a function that returns an element and an `unmount`. `lib/live.ts` holds the single WebSocket and replays the last snapshot to late subscribers so pages don't mount empty. The node worker runs in a Web Worker (`worker/node.worker.ts`) so model loading and generation never touch the main thread.

Animations are CSS plus one `IntersectionObserver` reveal pass per page and one `requestAnimationFrame` number tween. The receipt printing effect is a `clip-path` animation. All of it is off under `prefers-reduced-motion`.

## Files worth reading first

- `packages/shared/src/index.ts`: types, `canonical()`, constants.
- `apps/api/src/core/router.ts`: the whole job lifecycle.
- `apps/api/src/auth.ts`: both auth schemes.
- `packages/shared/src/node-client.ts`: what a node does.
- `apps/web/src/pages/earn.ts`: the in-browser node.
