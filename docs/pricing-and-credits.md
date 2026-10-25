# Pricing and credits

Credits are the unit of account inside the router. They are not a currency, there's no exchange rate baked in, and nothing about them promises a return. They exist so that a requester can be charged and a node can be paid in the same table.

One credit is 1,000,000 micro-credits (µcr). All arithmetic is on integer µcr. There are no floats in the ledger and there never will be.

## Where credits come from

- A new anonymous session gets 50,000 µcr (0.05 cr) once, keyed to its cookie. That's enough to try the chat a few dozen times.
- An API key starts at zero. The operator grants credits with `node apps/api/scripts/grant.mjs <accountId> <credits>`. If you want people to buy credits, put a payment flow in front of that script; the ledger doesn't care where a grant came from.
- A node earns credits on every receipt. They land in the node's own account and can be spent on inference like any other credits, or paid out.

## Two billing modes

A job carries `billing: "tokens"` (default) or `billing: "time"`.

**Tokens.** Nodes publish `pricePer1k`, micro-credits per thousand output tokens (or per thousand compute units). The hold is `maxOutputTokens × price / 1000`; the charge is actual units × price. This is for small open models where the market prices per token.

**Time.** Nodes publish `pricePerHour`. The requester sets `maxSeconds`; the hold is `maxSeconds × hourly / 3600`. On completion the router measures seconds from claim to completion on its own clock and charges that. A node's receipt names a cost based on the same start time it was handed at claim; the router accepts it if it is within two seconds' worth of its own figure and under the hold. This is how card-hour pricing on the Pricing page is billed, and it is what suits generation, fine-tuning, embeddings over large corpora and customer-supplied models: work that needs a whole card for a while.

Routing picks the cheapest capable node by whichever price applies to the job's billing mode.

## How one job is priced

Nodes publish a price per thousand units and a price per hour. For llm work a unit is an output token; for compute it's a thousand rounds of the hash chain. Floors are 200 µcr per 1k and 10,000 µcr ($0.01) per hour.

1. **Quote.** When a job comes in, the router looks at every online, idle node that could run it and takes the lowest price. The hold is `ceil(maxOutputTokens × price / 1000)`. If no node is online the floor is used and the job waits.
2. **Hold.** That amount is debited from the requester inside a transaction. Two concurrent requests can't both spend the last credit.
3. **Run.** The node reports a token count. The router caps it at roughly half the character count of the text plus a few, so a node can't bill for tokens that aren't there.
4. **Settle.** Cost is `min(hold, ceil(units × that node's price / 1000))`, minimum 1 µcr. The difference between the hold and the cost is refunded. The cost is credited to the node.
5. **Fail.** If the job fails after three attempts, or is cancelled, the whole hold is refunded.

Every one of those movements is a row in `ledger` with a `kind` (`grant`, `charge`, `earn`, `payout`, `refund`) and a `ref` pointing at the job or payout. Balances are sums over that table; there's no separate balance column to drift.

## Rate limits

- `POST /v1/chat/completions` and `POST /v1/jobs`: 20 per minute per address (`INFER_RPM`).
- `POST /v1/access`: 5 per hour per address.
- `POST /v1/benchmark/ticket`: 10 per hour per address.
- `POST /v1/nodes/register`: 30 per minute per address.

These are about protecting nodes and the queue, not the operator's wallet. Work runs on node hardware, so a burst of requests costs the operator nothing beyond a busier SQLite file.

## What this does not do

- No prepaid tiers, no subscriptions, no volume discounts. The price is whatever the cheapest node asked for.
- No bidding. A node that wants more work lowers its price.
- No conversion between credits and anything else inside the router. See [Payouts and tiers](/docs/payouts-and-tiers) for what leaves the system and how.
