# Nightshift

Nightshift is a router for inference across other people's GPUs. A business sends work in the OpenAI chat format. The router finds the cheapest machine on the network that can run it, runs it there, verifies what comes back, and returns the answer with a receipt. The receipt is signed twice: once by the machine that did the work, once by the router that checked it.

The machines belong to node operators who run the agent and are paid per task by their hardware class. Cloud cards and external APIs have a slot in the design but are switched off on this router.

## What's actually in the box

- **A router** (`apps/api`). Fastify, TypeScript, SQLite. Takes jobs, ranks nodes by price, hands out leases, verifies results, keeps a ledger, signs receipts, and pushes a live feed over a WebSocket.
- **A web app** (`apps/web`). The landing page, a working chat, the live network map, the in-browser node, and a receipt verifier. No framework; plain TypeScript and one stylesheet.
- **A shared package** (`packages/shared`). Types, the canonical-JSON routine that receipts are signed over, the compute task, and the node client that both workers use.

## The one idea

Everything is built around the receipt. A node can't claim it did work without signing a body that names the job, the hashes of the input and output, the timings and the cost. The router can't forge one either, because the node's signature is part of what the router signs. Anyone holding the receipt can check both signatures with nothing but two public keys. The Verify page does exactly that, in your browser.

## Where to go next

- [Quickstart](/docs/quickstart): run it locally in two commands.
- [Console](/docs/console): send tasks from the browser, as a business or as the operator.
- [API](/docs/api): every endpoint with curl examples.
- [Receipts](/docs/receipts): the exact bytes that get signed.
- [Earning](/docs/earning): what node operators are paid, by hardware class, and how to cash out.
- [Run a node](/docs/run-a-node): the agent, its settings, serving model tasks.
- [Privacy](/docs/privacy): what each party can see. Pseudonymous, not anonymous.
- [Pricing and credits](/docs/pricing-and-credits): how a job is quoted, charged and paid.
- [Architecture](/docs/architecture): the job lifecycle and why nodes pull.
- [Payouts and tiers](/docs/payouts-and-tiers): what's wired, what's a stub, and how to plug in a real rail.
- [Deploy](/docs/deploy): one process, one SQLite file, one reverse proxy.
