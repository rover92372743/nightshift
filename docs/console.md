# Console

The console is the page where work gets sent. It is a terminal with a form next to it; both do the same thing. Businesses sign in with the API key they were given, type or click a task, and watch it get routed, run and receipted. The operator signs in with the admin key and gets a few more commands for running the shop.

Open it at `/console`.

## Signing in

```
login ns_…
```

The key is kept in this tab only (session storage) and is gone when the tab closes. Anonymous visitors get a small trial allowance by cookie, so the console works without signing in; it just won't get far.

Need a key? `key new my-label` mints one. It starts at zero credit, so the next step is asking the operator to add some (or, once a payment rail is wired, paying).

## Sending a task

Type:

```
run "Summarise this in two lines: …" --model qwen2.5-7b-instruct --max 200
run "Translate to French: …" --time 30          # bill by card-seconds instead of tokens
compute 200000                                  # a hash-chain job, any machine can take it
```

Or use the form on the right: pick the kind, the model, write the prompt, choose billing, send. The console echoes the equivalent command so you learn the syntax by watching.

What you see after sending:

```
→ job_a1b2  queued  qwen2.5-7b-instruct · 200 max tokens · hold $0.04
job_a1b2  running on steady-maple-365…
job_a1b2  done on steady-maple-365 · 2.1 s · 187 units · $0.03 charged ($0.04 held)
  <the reply>
receipt rcpt_9f…  ·  type "receipt rcpt_9f…" to verify
```

The hold is the quote; the charge is what was used. The difference comes straight back.

## Reading back

| Command | What it does |
|---|---|
| `me` | Account, balance, recent ledger |
| `jobs` | Your last 20 tasks |
| `job <id>` | One task in full, with its receipt verified |
| `receipt <id>` | Fetch a receipt and check both signatures |
| `clear`, `Ctrl-L` | Wipe the screen |

Operators of the machines that ran your tasks never see the prompt or the reply; they see hashes and timings. See [Privacy](/docs/privacy).

## Operator commands

Set `NIGHTSHIFT_ADMIN_KEY` in the router's environment, then:

```
admin <that key>
accounts                       every business and session account, with balances
keys new "Acme eval team" 500  mint a key for a customer with an opening balance of $500
grant acct_… 250 "invoice 1042"   add credits (negative numbers claw back)
quotes                         inquiries sent from the pricing page
all                            last 50 tasks across every account, content hidden
```

Without the environment variable the `/v1/admin` routes answer 404, so a router that was never configured for it exposes nothing. The admin key is compared in constant time and is never written to the database.

## From code

Everything the console does is the public API with a bearer token. The [API](/docs/api) page has the curl, and `POST /v1/chat/completions` works with any OpenAI-compatible client by changing the base URL.
