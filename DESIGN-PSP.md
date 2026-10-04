# Integrating the 50th PSP

A new PSP should be a new adapter and a config block. It should not be a change to the wallet, the ledger, or the funding state machine. `handlePspCallback` already accepts a normalized callback. The mock route in `src/routes/psp.ts` is the only code that knows this provider's JSON. That split is the seam.

## Shape

```typescript
interface RawCallback {
  headers: Record<string, string | undefined>;
  rawBody: Buffer; // HMAC input. Never re-serialize parsed JSON.
}

type NormalizedStatus = 'pending' | 'completed' | 'failed' | 'unknown';

interface NormalizedCallback {
  pspRef: string;           // our reference, echoed by the provider
  providerEventId: string;  // their id, for logs and support
  status: NormalizedStatus;
  amount: string;           // major units, decimal string, 18 dp max
  rawStatus: string;        // untouched provider token, for the audit log
}

interface PspAdapter {
  readonly code: string;    // 'acme', stable, used in the URL and config
  verify(input: RawCallback): void;                 // throw on a bad signature
  normalize(input: RawCallback): NormalizedCallback; // throw on a shape we cannot read
}
```

`POST /psp/:code/callbacks` looks up the adapter, calls `verify`, then `normalize`, then the existing funding service. Verification and normalization live in the adapter. The funding service never sees provider field names, signature schemes, or minor units.

`unknown` does not move money and does not change status. The adapter maps the provider's vocabulary (`success`, `paid`, `1`) onto our four values. It does not weaken the state machine. A provider that sends `success` and later `pending` either has that second call normalized to a no-op, or the state machine returns 409. Which of those is correct goes in the provider's one-page quirk sheet, not in `wallet_txs`.

Amount conversion is integer-safe and happens before the funding service compares amounts. Minor units become a decimal string in the adapter (`"10050"` with scale 2 becomes `"100.50"`). The funding service keeps today's rule: the normalized amount must equal the authorized deposit, or the callback is refused and the deposit stays `pending`.

## Config

Adapters register in code (`code → adapter`). Enablement, secrets, and quirks come from config, loaded at boot:

```yaml
psps:
  - code: acme
    enabled: true
    secretEnv: ACME_WEBHOOK_SECRET
    amount: { unit: minor, scale: 2 }
    apply: false          # shadow: verify + normalize + log, do not post the ledger
```

Boot fails if an enabled code has no adapter or its secret is missing. A typo then breaks deploy, not the first live payment. `apply: false` is how a junior ships the integration before any money moves. A lead flips `apply` after the fixture tests and a sandbox payment look right.

Express must expose the raw body to `verify`. `express.json()` alone is the wrong place to check a signature, because the HMAC is over the bytes the provider sent.

## A junior's day

1. Read the provider docs and fill a quirk sheet: signature, status map, amount units, retry behavior, and whether they emit a later status that contradicts an earlier one.
2. Add the config block. Do not set `apply: true`.
3. Add `src/psp/adapters/<code>.ts` implementing `verify` and `normalize` only. No Sequelize in that file.
4. Add fixture tests from sanitized real payloads. CI computes the signature with the test secret. CI does not call the provider.
5. Open a PR. The funding-service tests stay untouched unless the normalized contract changed, which it should not.
6. After review, run one sandbox payment by hand (or the nightly job). Then flip `apply`.

## Tests when the provider is not callable

The state machine, the single credit, and the wallet lock are already tested against Postgres with a normalized callback. A new provider adds tests only at its edge:

- Fixture in, expected `NormalizedCallback` out, including minor-unit amounts and each status token.
- A mutated byte fails `verify`.
- An unmapped status becomes `unknown` and a test at the route asserts that the wallet did not change.
- Duplicate and out-of-order fixtures run through the real callback service, so we see that this provider's noise does not double-credit.

A nightly sandbox job can hit the provider outside the merge gate. It is quarantined, uses a test member, and pages a person. It does not block CI. Recorded fixtures are the contract we actually regress.
