# Docket

One endpoint for inference. Each request runs on the cheapest machine that can take it and comes back with a receipt signed by that machine and by the router that checked it. Your own computer can be one of those machines.

```sh
npm install
npm run dev
```

Router on `:8787`, site on `:5173`. Open `/earn`, press start, then talk to it on `/chat`.

## Layout

```
apps/api         Fastify router: jobs, nodes, ledger, receipts, live feed (TypeScript, SQLite)
apps/web         The site: landing, chat, network map, in-browser node, verifier (Vite, no framework)
packages/shared  Types, canonical JSON, compute task, node client — runs in Node and the browser
docs/            What the site's Docs section renders
```

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | API and site with reload |
| `npm run build` | Everything to `dist/` |
| `npm start` | The built API; set `DOCKET_STATIC=apps/web/dist` to serve the site too |
| `npm run worker` | A terminal node that serves compute jobs |
| `npm run typecheck` | All three workspaces |
| `npm test` | API tests |
| `node apps/api/scripts/grant.mjs <acct> <credits>` | Top up an account |

## What's real and what isn't

Real: routing, leases, signed receipts, the ledger, rate limits, the browser worker with a small model on WebGPU, the live map, the verifier.

Not real: payouts to USDC or SOL. The adapter interface is there and the default implementation records the request and waits for a human. See `docs/payouts-and-tiers.md` before telling anyone they'll be paid in anything other than credits.

## Docs

Start at `docs/index.md`, or run the site and open `/docs`.
