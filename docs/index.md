# Docket

Docket is a router for inference. You send it a request in the OpenAI chat format. It finds the cheapest machine on the network that can run that request, runs it there, and gives you the answer along with a receipt. The receipt is signed twice: once by the machine that did the work, once by the router that checked it.

Those machines can be anything. Right now the two kinds that exist are browser tabs (someone opened the Earn page and pressed start) and native workers (the script in `apps/api/scripts`). Cloud cards and external APIs have a slot in the design but are switched off on this router.

## What's actually in the box

- **A router** (`apps/api`). Fastify, TypeScript, SQLite. Takes jobs, ranks nodes by price, hands out leases, verifies results, keeps a ledger, signs receipts, and pushes a live feed over a WebSocket.
- **A web app** (`apps/web`). The landing page, a working chat, the live network map, the in-browser node, and a receipt verifier. No framework; plain TypeScript and one stylesheet.
- **A shared package** (`packages/shared`). Types, the canonical-JSON routine that receipts are signed over, the compute task, and the node client that both workers use.

## The one idea

Everything is built around the receipt. A node can't claim it did work without signing a body that names the job, the hashes of the input and output, the timings and the cost. The router can't forge one either, because the node's signature is part of what the router signs. Anyone holding the receipt can check both signatures with nothing but two public keys. The Verify page does exactly that, in your browser.

## Where to go next

- [Quickstart](/docs/quickstart): run it locally in two commands.
- [API](/docs/api): every endpoint with curl examples.
- [Receipts](/docs/receipts): the exact bytes that get signed.
- [Run a node](/docs/run-a-node): from a tab or a terminal.
- [Pricing and credits](/docs/pricing-and-credits): how a job is quoted, charged and paid.
- [Architecture](/docs/architecture): the job lifecycle and why nodes pull.
- [Payouts and tiers](/docs/payouts-and-tiers): what's wired, what's a stub, and how to plug in a real rail.
- [Deploy](/docs/deploy): one process, one SQLite file, one reverse proxy.
