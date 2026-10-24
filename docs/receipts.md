# Receipts

A receipt is the proof that a particular job ran on a particular node and produced a particular output, and that the router checked and accepted it. It has to be verifiable by someone who has never talked to the router, so it carries everything it needs.

```json
{
  "id": "rcpt_…",
  "body": {
    "v": 1,
    "jobId": "job_…",
    "nodeId": "nd_…",
    "nodeClass": "browser",
    "workload": "llm",
    "model": "qwen2.5-0.5b-instruct",
    "inputHash": "sha256 hex of canonical(job input)",
    "outputHash": "sha256 hex of the output text (llm) or digest (compute)",
    "outputTokens": 41,
    "units": 41,
    "startedAt": 1792873370985,
    "finishedAt": 1792873372985,
    "costMicro": 11
  },
  "nodeSig": "base64url ed25519 over canonical(body)",
  "routerSig": "base64url ed25519 over canonical(body) + '.' + nodeSig",
  "nodeKey": "base64url ed25519 public key",
  "routerKey": "base64url ed25519 public key"
}
```

## Canonical JSON

Signatures are over a canonical serialisation of `body`, not whatever JSON happened to be on the wire. The rules are short:

- Object keys sorted by code point, recursively.
- No whitespace.
- Keys whose value is `undefined` are dropped.
- Numbers and strings as `JSON.stringify` writes them.

The implementation is `canonical()` in `packages/shared/src/index.ts`. It's about fifteen lines, and it's the one piece of code you should not change casually, because doing so invalidates every receipt that exists.

## What the router checks before it countersigns

When a node calls `complete`, the router rebuilds the parts of the body it knows and compares field by field:

1. `jobId`, `nodeId`, `nodeClass`, `workload`, `model`, `inputHash` must match the job as the router recorded it.
2. `outputHash` must equal the hash the router computes over the output the node sent in the same request.
3. `units` and `outputTokens` must equal the counters in `output`.
4. `nodeSig` must verify against the node's registered public key over `canonical(body)`.
5. For llm jobs, the token count is capped at what the returned text could plausibly contain. A node can under-report; it can't over-report by much.
6. For compute jobs, the router re-runs the hash chain itself (always for jobs under 200k rounds, one in ten above that). A wrong digest fails the job and counts against the node.
7. `costMicro` must equal what the router would charge: `min(hold, ceil(units × node price / 1000))`.

Only then does it sign, settle, store, and emit `job.done`.

## Verifying one yourself

With Node and tweetnacl:

```js
import nacl from 'tweetnacl';
import { canonical } from '@docket/shared';

const b64u = (s) => Buffer.from(s, 'base64url');
const msg = (s) => new TextEncoder().encode(s);

const canon = canonical(receipt.body);
const nodeOk = nacl.sign.detached.verify(msg(canon), b64u(receipt.nodeSig), b64u(receipt.nodeKey));
const routerOk = nacl.sign.detached.verify(msg(canon + '.' + receipt.nodeSig), b64u(receipt.routerSig), b64u(receipt.routerKey));
```

If you want to know it came from *this* router rather than any router, compare `receipt.routerKey` with `GET /v1/router-key` once and pin it.

The web app's Verify page does the same thing in the browser with the same library.

## What a receipt does not prove

It doesn't prove the output was *good*. It proves that a specific node produced a specific output for a specific input, that the node put its name to it, and that the router accepted it. For compute jobs the router also checks the output is correct. For llm jobs there's no such check; the model is whatever the node loaded. That's a known gap, and the honest fix is redundant execution with comparison, which is on the list but not built.
