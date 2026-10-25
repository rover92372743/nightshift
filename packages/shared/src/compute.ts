// The "compute" workload: a deterministic hash chain. Not useful work in
// itself, but it is cheap to run, impossible to fake without doing it, and
// the router can re-run a sample of jobs to check nodes are honest. Runs on
// WebCrypto so the same code executes in Node and in a browser worker.

const enc = new TextEncoder();

function hex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function computeTask(seed: number, rounds: number): Promise<string> {
  let state = enc.encode(`nightshift:${seed}`);
  for (let i = 0; i < rounds; i++) {
    const digest = await crypto.subtle.digest('SHA-256', state);
    // Mix the round counter in so a node can't memoise across rounds.
    const next = new Uint8Array(36);
    next.set(new Uint8Array(digest), 0);
    new DataView(next.buffer).setUint32(32, i, true);
    state = next;
  }
  return hex(await crypto.subtle.digest('SHA-256', state));
}

export const COMPUTE_MIN_ROUNDS = 1_000;
export const COMPUTE_MAX_ROUNDS = 2_000_000;
/** One work unit = this many rounds. Pricing is per 1k units. */
export const COMPUTE_ROUNDS_PER_UNIT = 1_000;
