# Payouts and tiers

This page is about the parts that are deliberately not finished, so that nobody reads the landing page and assumes they are.

## Payouts

Payouts are USDC on Solana, and every one is approved by a person. The router never holds a private key or talks to a chain.

The flow:

1. A node asks (`POST /v1/nodes/:id/payouts` with `amountMicro` and a Solana `address`). The router checks: valid base58 address, balance ≥ $15, amount ≥ $15 and ≤ balance, no other request pending for that account. The amount is debited at once so it cannot be spent twice, and a `payouts` row is written as `pending`.
2. The operator opens the console in operator mode. The **Payout requests** panel (or `payouts` in the terminal) lists every pending request with the requester (node label and id), the address, the amount, the account's balance after the hold, lifetime earnings and task count, how many prior requests the account has made, and whether any other account has asked to be paid to the same address. Those last ones are flagged, because they are what fraud looks like.
3. The operator sends the USDC from the treasury wallet with whatever they use for that, then records the transaction signature (`approve <id> <signature>`, or the "Mark sent" button). The row flips to `sent` and the requester sees the signature.
4. Or the operator declines (`reject <id> [reason]`) and the credits are posted back to the account in the same transaction.

A `sent` row can't be re-approved and a `rejected` one can't be sent; both are final. `PAYOUT_MIN_MICRO` in the shared package is the minimum.

There is no automatic rail on purpose. If you later want one, the shape is simple: a job that watches for `pending` rows, sends, and calls the same `approve` path with the signature. But a human in the loop is the right default while the network is small.

## Tiers

Nodes have a class: `browser`, `native`, `cloud`, `external`. The first two are real. The other two are refused at registration unless `EXTERNAL_ENABLED=true`.

**Cloud** is meant for cards you rent and run the worker on. Nothing special is needed; it's a native node with a different label and, presumably, a higher price. The class exists so the map can show it separately.

**External** is for paid third-party APIs. The idea is an adapter node that takes an llm job, forwards it to a vendor, and signs a receipt for the result. That's the one place in the system where a request can cost the operator real money per token, which is why it's off by default and why, if you turn it on, you should also:

- never let an anonymous session route there (set the adapter node's price above what 0.05 cr can buy, or add a class check in `candidates`);
- set `maxOutputTokens` on the adapter to something you can afford to be wrong about;
- treat the vendor key like the router key.

No external adapter is included. The slot is there; what goes in it is your call.
