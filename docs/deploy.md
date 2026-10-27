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
NIGHTSHIFT_STATIC=apps/web/dist \
NIGHTSHIFT_DB=/var/lib/nightshift/nightshift.db \
NIGHTSHIFT_KEY=/var/lib/nightshift/router.key \
CORS_ORIGINS=https://nightshift.example \
PORT=8787 \
npm start
```

With `NIGHTSHIFT_STATIC` set the API serves the built site and falls back to `index.html` for any path that isn't under `/v1`, so client-side routes work on reload.

### Environment

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `8787` | |
| `HOST` | `0.0.0.0` | |
| `NIGHTSHIFT_DB` | `data/nightshift.db` | SQLite file; directory is created |
| `NIGHTSHIFT_KEY` | `data/router.key` | ed25519 secret, generated if missing, mode 0600 |
| `NIGHTSHIFT_STATIC` | unset | Serve this folder as the site |
| `CORS_ORIGINS` | `http://localhost:5173,…` | Comma-separated. Only matters if the site is on another origin |
| `INFER_RPM` | `20` | Per-address limit on inference endpoints |
| `EXTERNAL_ENABLED` | `false` | Allow `cloud` and `external` node classes |
| `LOG_LEVEL` | `info` | pino level |
| `REQUEST_LOGGING` | `false` | One log line per request. Addresses and auth headers are redacted even when on |
| `CONTENT_RETENTION_MIN` | `10` | Minutes to keep prompt/reply text after a job finishes; hashes stay. `0` keeps text |
| `NIGHTSHIFT_ADMIN_KEY` | unset | Operator key for the console's admin commands and `/v1/admin`. Unset = those routes answer 404 |

### Reverse proxy

Put nginx or Caddy in front for TLS. The WebSocket at `/v1/network/live` needs upgrade headers passed through. Caddy does that without being asked:

```
nightshift.example {
  reverse_proxy localhost:8787
}
```

### Back up two things

`nightshift.db` (and its `-wal`/`-shm` siblings while running) and `router.key`. The database is the ledger. The key is what makes every receipt the router ever issued checkable. Losing the first loses money; losing the second loses history.

### Split hosting

If the site lives on a static host instead, build it with the API origin baked in:

```sh
VITE_API_URL=https://api.nightshift.example npm run build -w apps/web
```

Set `CORS_ORIGINS` on the API to the site's origin. The cookie-based anonymous session then relies on `SameSite=Lax` plus `credentials: 'include'`, which works across subdomains of one site and not across unrelated domains. For unrelated domains, use API keys.

## Operating it

- Grant credits: `node apps/api/scripts/grant.mjs <accountId> <credits> [note]`.
- Settle pending payouts: `SELECT * FROM payouts WHERE status='pending'`, send the money however you do that, then `UPDATE payouts SET status='sent', tx_ref=?, settled_at=? WHERE id=?`. Or write an adapter and let it do this.
- Watch it: `/v1/network` is cheap to poll, and the WebSocket feed is what the site uses.
- Logs are pino JSON on stdout.

There's no admin UI. It's a small system and SQLite's shell is a fine one.

## Vercel site + VPS API

The split used for the hosted version: the site on Vercel, the API on a small VPS behind Caddy.

**API (any Ubuntu/Debian VPS, as root):**

```sh
curl -fsSL https://raw.githubusercontent.com/rover92372743/nightshift/main/deploy/setup.sh | bash
nano /opt/nightshift/.env        # set API_DOMAIN and CORS_ORIGINS
cd /opt/nightshift && docker compose up -d --build
```

Point an A record for `API_DOMAIN` at the server first; Caddy fetches the certificate on boot. The ledger and signing key live in the `nightshift-data` Docker volume. Updating later is `git pull && docker compose up -d --build`. Back up the volume: `docker run --rm -v nightshift_nightshift-data:/data -v $PWD:/out alpine tar czf /out/nightshift-backup.tgz /data`.

**Site (Vercel):** import the repo; `vercel.json` sets the build. Add one environment variable, `VITE_API_URL=https://<API_DOMAIN>`, and redeploy. Use a subdomain of the same domain for the API (`example.com` + `api.example.com`) so the console's cookie session works.
