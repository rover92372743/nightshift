# Privacy

What each party can see, what the router keeps, and what you can't fix from inside the router. Read this before telling anyone the network is "anonymous". It isn't. It's pseudonymous, with a short memory.

## If you run a node

**The router sees your IP address and your browser's User-Agent.** Every HTTP connection carries both. By default the router does not write them anywhere: request logging is off (`REQUEST_LOGGING=false`) and, if you turn it on, the address, User-Agent, cookie and auth headers are redacted before they reach the log. Rate limiting keeps a per-address counter in memory for one minute. Nothing else touches the address. If you need the router not to see it at all, that's a VPN or Tor on your side; software on the router can't help.

**Your node has a persistent identity: its public key.** The key is generated in your browser (or in `~/.nightshift/worker.key` for the terminal worker) and the secret never leaves your machine. The router stores the public half, and every receipt you sign carries it. That means all your jobs are linkable to each other, the way transactions from one wallet are. If you want a fresh identity, clear site data (browser) or delete the key file (terminal). Your balance stays with the old key.

**Your label is public.** It appears on the map, in the public node list and in the live feed. The default is a random two-word name with a number, which says nothing about you. If you type "Dave's gaming PC", that's on you.

**Also public:** your node's class (browser/native), its price, its size limits, the models it serves, how many jobs it has completed, and whether it's busy right now. All of these are needed for routing or for the map. None of them identify a device.

**Not public:** your earnings, balance, ledger, job history and payout requests. Those are behind the signed `/v1/nodes/:id/me` endpoint and only the key holder can read them.

**A third party sees you once:** loading the chat model in a browser downloads weights from Hugging Face's CDN. They see your IP for that download. The browser caches the files, so it's once per browser. The terminal worker and compute-only browser nodes never contact anyone but the router.

**You see the requester's prompt.** That's inherent; you're the one running it. You do not see who sent it. The job the router hands you carries the input, the hashes and the price, and the requester's id is replaced with the word `hidden`.

## If you send requests

**The node that runs your job sees your whole prompt.** It has to. The router cannot verify what a node does with the text it was given. Treat every prompt as readable by a stranger, because it is. If that's not acceptable for a given prompt, don't send it here; this is a public compute network, not a confidential one. Compute jobs carry no text at all.

**The router sees your IP** under the same terms as nodes above: not logged by default, redacted if logging is on.

**The router keeps your prompt and the reply for a short time.** Both are stored so you can fetch the result. Ten minutes after the job finishes (`CONTENT_RETENTION_MIN`), the text is replaced with a placeholder and only the SHA-256 hashes remain, which is all the receipt ever contained. Set it to `0` if you want text kept, for debugging, and know what you're doing.

**Anonymous sessions are a cookie.** It's a random id, `HttpOnly`, `SameSite=Lax`, no account behind it. Delete the cookie and you're a new session with a new allowance. API keys are stored hashed.

## What's public from the router

| Endpoint | What anyone can read |
|---|---|
| `/v1/network` | Counts, latency percentiles, floor price |
| `/v1/nodes` | Online nodes: id, label, class, status, capabilities, jobs done |
| `/v1/receipts` | The ten latest receipts: ids, hashes, node id, class, timing, cost |
| `/v1/network/live` | The same, as events |

No prompt text, no reply text, no addresses, no balances, no account ids appear on any of them.

**Region.** A node can choose to say which metro area it is in (`region`, one of a fixed list of about forty cities). That is what places it on the globe on the Network page. It is opt-in, it is the only location field that exists, and the router throws away anything that is not on the list, so there is no way to send a street, a postcode or coordinates even by accident. The router never derives a region from your IP address. Leave it unset and your node is counted in the totals but pinned nowhere.

## What the receipt reveals

A receipt names the node that ran the job (by id and public key) and the job id. Anyone holding a receipt can therefore tell which node produced a given output. That's the point of the receipt; a receipt that didn't name the node would prove nothing. If you need to show someone a receipt without exposing which node did the work, you can't. The design trades that for verifiability.

## What this does not protect against

- A malicious node logging prompts. Nothing can, short of running the model inside something like an enclave, which browser tabs don't have.
- Traffic analysis by whoever runs the router or sits on the wire between you and it. Timing and sizes leak even when content doesn't.
- The router operator reading the database before the retention window passes. They own the disk. Ten minutes is a default, not a guarantee against the person holding the keys.
- Correlation across sessions if you reuse a node key or an API key. Rotate them if that matters.

If you deploy this and want to promise users more than the above, you need to change the design, not the wording.
