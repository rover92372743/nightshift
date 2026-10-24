# Quickstart

You need Node 20 or newer. Nothing else.

```sh
git clone <your fork> docket
cd docket
npm install
npm run dev
```

That starts the router on `http://localhost:8787` and the web app on `http://localhost:5173`. The web app proxies `/v1` to the router, so the browser only ever talks to one origin.

On first boot the router writes two files into `data/`: `docket.db` (SQLite) and `router.key` (its ed25519 secret). Keep the key. If you lose it, every receipt the router has ever countersigned becomes unverifiable against the new key, which is a worse day than it sounds.

## Get a node online

```sh
npm run worker
```

That starts the agent: it detects your GPU, picks a price for its class, registers, and waits for work. It serves compute tasks out of the box; to serve model tasks, point it at a local model server (see [Run a node](/docs/run-a-node)). Open `http://localhost:5173/network` to watch it on the map, and `npm run cli` to see its earnings.

The Earn page can also start a lightweight CPU node inside a browser tab, which is a quick way to see the flow without installing anything.

## Make a request from code

Anonymous browser sessions get a small allowance by cookie. From code you want a key:

```sh
curl -s -X POST localhost:8787/v1/keys \
  -H 'content-type: application/json' \
  -d '{"label":"laptop"}'
# {"accountId":"acct_…","apiKey":"dk_…","note":"store this; it is not shown again"}
```

Keys start empty. Top one up as the operator:

```sh
node apps/api/scripts/grant.mjs acct_… 5
```

Then point any OpenAI-compatible client at `/v1` (press **Send a test job** on the home page first if no model node is online; compute tasks run on any node):

```sh
curl -s localhost:8787/v1/chat/completions \
  -H 'authorization: Bearer dk_…' \
  -H 'content-type: application/json' \
  -d '{
    "model": "qwen2.5-0.5b-instruct",
    "messages": [{"role":"user","content":"Two sentences on why receipts matter."}],
    "max_tokens": 120
  }'
```

The response is the usual `chat.completion` shape plus a `docket` object with the job id, node id, receipt id, cost and duration. Streaming isn't supported yet; omit `stream` or you'll get a 400 telling you so.

## Check the receipt

```sh
curl -s localhost:8787/v1/receipts/rcpt_…
```

Or paste the JSON into `/receipts` and let your browser check the signatures.
