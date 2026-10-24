# Deploy

The router is one process and it can serve the web app itself, so the smallest deployment is one small VM.

## Build

```sh
npm ci
npm run build
```

That produces `packages/shared/dist`, `apps/api/dist` and `apps/web/dist`.

## Run

```sh
DOCKET_STATIC=apps/web/dist \
DOCKET_DB=/var/lib/docket/docket.db \
DOCKET_KEY=/var/lib/docket/router.key \
CORS_ORIGINS=https://docket.example \
PORT=8787 \
npm start
```

With `DOCKET_STATIC` set the API serves the built site and falls back to `index.html` for any path that isn't under `/v1`, so client-side routes work on reload.

### Environment

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `8787` | |
| `HOST` | `0.0.0.0` | |
| `DOCKET_DB` | `data/docket.db` | SQLite file; directory is created |
| `DOCKET_KEY` | `data/router.key` | ed25519 secret, generated if missing, mode 0600 |
| `DOCKET_STATIC` | unset | Serve this folder as the site |
| `CORS_ORIGINS` | `http://localhost:5173,…` | Comma-separated. Only matters if the site is on another origin |
| `INFER_RPM` | `20` | Per-address limit on inference endpoints |
| `EXTERNAL_ENABLED` | `false` | Allow `cloud` and `external` node classes |
| `LOG_LEVEL` | `info` | pino level |

### Reverse proxy

Put nginx or Caddy in front for TLS. The WebSocket at `/v1/network/live` needs upgrade headers passed through. Caddy does that without being asked:

```
docket.example {
  reverse_proxy localhost:8787
}
```

### Back up two things

`docket.db` (and its `-wal`/`-shm` siblings while running) and `router.key`. The database is the ledger. The key is what makes every receipt the router ever issued checkable. Losing the first loses money; losing the second loses history.

### Split hosting

If the site lives on a static host instead, build it with the API origin baked in:

```sh
VITE_API_URL=https://api.docket.example npm run build -w apps/web
```

and set `CORS_ORIGINS` on the API to the site's origin. The cookie-based anonymous session then relies on `SameSite=Lax` plus `credentials: 'include'`, which works across subdomains of one site and not across unrelated domains. For unrelated domains, use API keys.

## Operating it

- Grant credits: `node apps/api/scripts/grant.mjs <accountId> <credits> [note]`.
- Settle pending payouts: `SELECT * FROM payouts WHERE status='pending'`, send the money however you do that, then `UPDATE payouts SET status='sent', tx_ref=?, settled_at=? WHERE id=?`. Or write an adapter and let it do this.
- Watch it: `/v1/network` is cheap to poll, and the WebSocket feed is what the site uses.
- Logs are pino JSON on stdout.

There's no admin UI. It's a small system and SQLite's shell is a fine one.
