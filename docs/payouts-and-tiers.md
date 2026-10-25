# Payouts and tiers

This page is about the parts that are deliberately not finished, so that nobody reads the landing page and assumes they are.

## Payouts

A node's earnings sit in its ledger account as credits. There are three things a node can ask for.

| Rail | What happens | Status |
|---|---|---|
| `credits` | Nothing. Credits are already spendable on inference. Returns `sent` immediately. | Works |
| `usdc` | From $15. Debits the credits, records a payout row as `pending`, returns it. | Stub |
| `sol` | From $15. Same as above. | Stub |

For the two chain rails, the router validates the address shape (base58, 32–44 characters), debits the amount so it can't be double-spent, and then calls a `PayoutAdapter`. The adapter that ships is `ManualAdapter`, which throws `PayoutPending` and leaves the row for a human. There is no signer, no treasury and no RPC connection in this codebase. If you tell people they'll get paid in USDC, you are promising to go settle those rows yourself.

### Plugging in a real rail

`apps/api/src/core/payouts.ts` defines:

```ts
interface PayoutAdapter {
  rail: 'usdc' | 'sol';
  validateAddress(address: string): boolean;
  send(amountMicro: number, address: string): Promise<string>; // returns a tx reference
}
```

Implement it, then in `app.ts` after `buildContext`:

```ts
ctx.payouts.use(new SolanaUsdcAdapter({ rpc, treasuryKeypair, mint, microPerUsdc }));
```

`send` runs after the credits are debited. Return a tx signature and the payout flips to `sent`. Throw anything other than `PayoutPending` and the payout is marked `failed` and the credits are refunded in the same transaction. Decide the exchange rate inside the adapter; the router has no opinion about what a credit is worth.

Minimum off-platform payout is $15 (`PAYOUT_MIN_MICRO` in the shared package). Credits can be kept and spent at any amount.

## Tiers

Nodes have a class: `browser`, `native`, `cloud`, `external`. The first two are real. The other two are refused at registration unless `EXTERNAL_ENABLED=true`.

**Cloud** is meant for cards you rent and run the worker on. Nothing special is needed; it's a native node with a different label and, presumably, a higher price. The class exists so the map can show it separately.

**External** is for paid third-party APIs. The idea is an adapter node that takes an llm job, forwards it to a vendor, and signs a receipt for the result. That's the one place in the system where a request can cost the operator real money per token, which is why it's off by default and why, if you turn it on, you should also:

- never let an anonymous session route there (set the adapter node's price above what 0.05 cr can buy, or add a class check in `candidates`);
- set `maxOutputTokens` on the adapter to something you can afford to be wrong about;
- treat the vendor key like the router key.

No external adapter is included. The slot is there; what goes in it is your call.
