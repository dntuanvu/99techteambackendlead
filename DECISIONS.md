# Decisions

## How this was produced

Cursor (Grok) drafted the implementation, the tests, and this note. I treat that as a draft, not a source of truth: the locking, the state machine, the amount-mismatch rule, and the turnover rule below are the decisions I will defend in review. If I cannot explain one of them from the code, it does not belong in the submission.

## Correctness bar

A bug in this flow is an incident. The properties I optimized for:

- A completed deposit credits the wallet once, including when the callback is retried or delivered concurrently.
- The wallet balance is a cache. It can be rebuilt from `wallet_txs`.
- Two debits cannot overdraw a wallet, and two credits cannot lose an update.
- A funding transaction only moves `pending → completed` or `pending → failed`. A contradictory callback is rejected.
- A withdrawal is allowed only when accrued turnover covers the total requirement, and the 422 tells the client the shortfall.

## Schema

`funding_transactions` holds both deposits and withdrawals. They share one state machine (`pending`, `completed`, `failed`), so one table with a `kind` column keeps the transitions in one place. Withdrawals leave `turnover_multiplier` null and have no `psp_ref` yet; deposits require both. Postgres treats nulls as distinct, so the unique index on `psp_ref` still allows many withdrawals.

`wallet_txs` is the ledger. Each row has a **positive** `amount` and a `direction` of `credit` or `debit`. A check constraint rejects a non-positive amount, so a sign bug cannot be stored as a negative credit. The balance is `sum(credits) - sum(debits)`. `balance_after` is a support annotation for that posting. It is not the replay key: `created_at` defaults to `now()`, and in Postgres `now()` is the transaction start time, so timestamp order is not commit order. Reconstruction uses the sum. A monotonic per-wallet sequence is the follow-up if we need to walk postings in apply order.

Turnover totals live on the wallet row (`turnover_required`, `turnover_accrued`) and as deltas on each ledger row. The row is a cache so the withdrawal check is one locked read. The deltas are how we rebuild the cache.

The wallet cache is written only from `postLedgerEntry`, in the same transaction as the ledger insert. `createMember` is the only other writer, and it writes zeros. An append-only trigger rejects `UPDATE` and `DELETE` on `wallet_txs`. A check constraint rejects a negative balance, so a debit that escapes the application check still rolls back.

## Deposit callback

Creating a deposit inserts a `pending` row and returns a generated `pspRef`. No balance change, no ledger row.

The callback runs in one `READ COMMITTED` transaction:

1. `SELECT … FOR UPDATE` the funding row by `pspRef`. Concurrent deliveries of the same callback queue here. The waiter sees the committed status.
2. If the row is already `completed` or `failed`, the same status with the same amount returns 200 and `alreadyApplied: true`. A different status is `409 invalid_transition`. A different amount is `409 amount_mismatch`.
3. If it is still `pending` and the amount matches, `failed` only flips the status. `completed` locks the wallet, credits it, writes one ledger row, adds `amount × turnoverMultiplier` to the requirement, then flips the status.
4. The ledger insert and the status change commit together. A crash before commit leaves the deposit `pending`, and the PSP retry settles it.

Duplicate callbacks return **200**, not 409. A non-2xx makes a PSP retry, sometimes for hours. A contradictory callback still returns 409, because acknowledging it would say we accepted a transition we refused.

Unknown `pspRef` is 404.

**Amount mismatch.** The callback amount must equal the amount the member authorized (`BigNumber` equality, so `100.50` and `100.500…` match). On a mismatch I do not credit, do not fail, and leave the row `pending`. Crediting the PSP's figure either gives the player money they did not authorize or shorts them. Failing the row lets a wrong callback kill a deposit that a correct retry could still complete. A deposit whose PSP never sends the authorized amount stays `pending` until an operator resolves it. That tool is not in this pass.

**Why the funding-row lock is load-bearing.** The unique index on `deposit:<funding id>` (and the partial unique index on `funding_transaction_id` where `kind = 'deposit'`) already stops two credits for the same deposit. That is enough for "ten identical `completed` callbacks." It is not enough for a `completed` and a `failed` in flight together. Without the row lock, one transaction can commit the credit while the other commits `status = failed`, or the later status write can overwrite `completed`. The lock makes the second delivery observe the terminal state and reject the contradiction. The mixed concurrent test asserts the invariant directly: `completed` means one credit and a matching balance; `failed` means no ledger row and a zero balance.

The unique-constraint catch around the transaction is the backstop for a forgotten lock on the *same* deposit. If the insert loses the race, we roll back and re-read. We only turn that into an idempotent 200 when the committed status and amount already match the callback.

## Wagers and withdrawals

Both take the wallet row with `FOR UPDATE` before reading the balance. The check and the update happen while that lock is held, then the ledger row is inserted in the same transaction.

That lock is what the concurrent wager test is actually about. Each wager has its own idempotency key, so the deposit unique index does not help. Without the lock, two transactions can both read a balance of 50 and both write 40. The balance check constraint stays silent because 40 is not negative, the player is debited once in the cache and twice in the ledger, and the cache and the ledger diverge. The test therefore asserts three things together: how many wagers succeeded, that the cache is zero, and that `reconstructWallet` equals the cache.

Withdrawals use the same lock. Turnover is checked first, then balance. If both fail, the client hears about the playthrough shortfall, because lowering the amount would still not pass. A successful withdrawal debits immediately and inserts a `pending` funding row, so the funds cannot be wagered again while a person approves it. There is no approval endpoint. Rejecting that withdrawal later requires a compensating credit. I did not build it.

Wager requests are **not** idempotent. A client retry is a second wager. The next change I would make is an `Idempotency-Key` header stored in `wallet_txs.idempotency_key`, with the same "re-read on unique violation" behavior as the callback.

## Turnover

The rule is cumulative: accrued turnover across the wallet must be at least the sum of `deposit amount × turnoverMultiplier` for completed deposits. Wagers add their stake to accrued. I stored it that way because that is what the brief says, not as per-deposit buckets.

`turnoverMultiplier` defaults to 1 and may be 0. Zero adds a requirement of 0, so the funds are withdrawable immediately. That is a useful case, and it is also why the unblock test can succeed. With a multiplier of 1 or more, meeting the requirement means wagering at least as much as was deposited. A wager only debits (there is no win/credit), so a single deposit cannot be withdrawn after it has been fully wagered unless more money arrives, or earlier wagers already created a surplus against a smaller requirement. I would ask product whether they want FIFO per-deposit buckets before changing this. Buckets are the usual bonus-wagering model, and they are a different rule from the one written here.

The product `amount × multiplier` must fit in `DECIMAL(36,18)`. If it does not, deposit creation returns 400 and nothing is stored.

## Locking choices I weighed

I use `READ COMMITTED` plus explicit row locks, always the funding row first and the wallet second when both are needed. Wagers and withdrawals lock only the wallet. That order has no cycle: a callback holds a funding row and waits for the wallet; a wager holds the wallet and does not need that funding row.

`SERIALIZABLE` would also prevent the lost update, and it would do it by aborting one of the transactions with `40001`. Callers would have to retry, including the PSP. The row lock waits and then proceeds, which matches "the duplicate callback should succeed and do nothing."

An optimistic `version` column was the other option. I left it out. `FOR UPDATE` already serializes the read-modify-write, and a version check that is not on the only write path is easy to bypass with a later `wallet.save()`. The balance check constraint is the debit backstop. It does not catch a lost credit, which is why the wallet lock stays mandatory in `postLedgerEntry`'s contract.

Each money transaction uses one connection. The pool max is 20 so overlapping callbacks and the concurrency tests are not serialized on the pool. A transaction that needed a second connection while holding a lock could deadlock against pool exhaustion; these transactions do not do that.

I did not set `lock_timeout`. In production I would set a few seconds so a stuck holder fails the waiter and the PSP retries, instead of occupying every connection.

## What I would do with more time

1. `Idempotency-Key` on wagers and withdrawals.
2. A reconciliation job that compares each wallet cache to `reconstructWallet` and alerts on drift. The query is already the one the tests use.
3. An operator action for a deposit stuck `pending` on amount mismatch: complete at the authorized amount, or fail, with an audit row.
4. A compensating credit when a pending withdrawal is rejected, as its own ledger kind, still inside one transaction.
5. A `bigint` sequence allocated at ledger insert time, so `balance_after` can be replayed in apply order.
6. `lock_timeout` on the money transaction.
7. Confirm with product whether turnover should stay cumulative or become per-deposit buckets.
8. The PSP seam in `DESIGN-PSP.md`, when a second provider exists. I did not build a registry for one mock. `handlePspCallback` already accepts a normalized body; `POST /psp/callbacks` is the only place that knows the mock JSON.

Out of scope on purpose: auth, HTTP idempotency middleware as a framework, queues, and a second ORM. The exercise fits in the starter.
