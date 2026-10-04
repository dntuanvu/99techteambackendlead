import BigNumber from 'bignumber.js';
import { DatabaseError, QueryTypes, Transaction } from 'sequelize';
import { sequelize } from '../db/sequelize';
import { Wallet, WalletTx } from '../db/models';
import type { LedgerDirection, LedgerKind } from '../db/models/walletTx';
import { AppError } from '../errors';
import { ZERO, dec, fitsMoneyColumn, moneyString } from '../lib/money';

export function inMoneyTransaction<T>(fn: (transaction: Transaction) => Promise<T>): Promise<T> {
  return sequelize.transaction({ isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED }, fn);
}

// SELECT ... FOR UPDATE. Callers that also lock a funding row must lock that row first.
export async function lockWalletById(id: string, transaction: Transaction): Promise<Wallet> {
  const wallet = await Wallet.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
  if (!wallet) throw new AppError(404, 'wallet_not_found');
  return wallet;
}

export async function lockWalletByMemberId(memberId: string, transaction: Transaction): Promise<Wallet> {
  const wallet = await Wallet.findOne({
    where: { memberId },
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  if (!wallet) throw new AppError(404, 'wallet_not_found');
  return wallet;
}

interface PostLedgerEntryInput {
  wallet: Wallet;
  kind: LedgerKind;
  direction: LedgerDirection;
  amount: BigNumber;
  turnoverRequiredDelta?: BigNumber;
  turnoverAccruedDelta?: BigNumber;
  fundingTransactionId: string | null;
  idempotencyKey: string;
  transaction: Transaction;
}

/**
 * Apply one balance change. The caller holds the wallet row lock inside `transaction`.
 * The wallet columns are a cache; the inserted row is the source of truth.
 */
export async function postLedgerEntry(input: PostLedgerEntryInput): Promise<WalletTx> {
  if (!input.amount.isGreaterThan(0) || !input.amount.isFinite()) {
    throw new Error('ledger amount must be a positive finite decimal');
  }

  const requiredDelta = input.turnoverRequiredDelta ?? ZERO;
  const accruedDelta = input.turnoverAccruedDelta ?? ZERO;
  if (requiredDelta.isNegative() || accruedDelta.isNegative()) {
    throw new Error('turnover deltas must be non-negative');
  }

  const current = dec(input.wallet.balance);
  const nextBalance = input.direction === 'credit' ? current.plus(input.amount) : current.minus(input.amount);
  if (nextBalance.isNegative()) {
    throw new AppError(422, 'insufficient_balance', {
      balance: moneyString(current),
      amount: moneyString(input.amount),
    });
  }

  const nextRequired = dec(input.wallet.turnoverRequired).plus(requiredDelta);
  const nextAccrued = dec(input.wallet.turnoverAccrued).plus(accruedDelta);
  if (!fitsMoneyColumn(nextBalance) || !fitsMoneyColumn(nextRequired) || !fitsMoneyColumn(nextAccrued)) {
    throw new AppError(422, 'amount_out_of_range');
  }

  input.wallet.balance = moneyString(nextBalance);
  input.wallet.turnoverRequired = moneyString(nextRequired);
  input.wallet.turnoverAccrued = moneyString(nextAccrued);

  try {
    await input.wallet.save({ transaction: input.transaction });
  } catch (err) {
    if (isConstraint(err, 'wallets_balance_non_negative')) {
      throw new AppError(422, 'insufficient_balance', {
        balance: moneyString(current),
        amount: moneyString(input.amount),
      });
    }
    throw err;
  }

  return WalletTx.create(
    {
      walletId: input.wallet.id,
      fundingTransactionId: input.fundingTransactionId,
      kind: input.kind,
      direction: input.direction,
      amount: moneyString(input.amount),
      balanceAfter: input.wallet.balance,
      turnoverRequiredDelta: moneyString(requiredDelta),
      turnoverAccruedDelta: moneyString(accruedDelta),
      idempotencyKey: input.idempotencyKey,
    },
    { transaction: input.transaction },
  );
}

export interface ReconstructedWallet {
  balance: string;
  turnoverRequired: string;
  turnoverAccrued: string;
}

// Authoritative reduction. Do not replay balance_after by created_at: Postgres now()
// is the transaction start time, so timestamp order is not apply order.
export async function reconstructWallet(walletId: string): Promise<ReconstructedWallet> {
  const rows = await sequelize.query<{
    balance: string;
    turnover_required: string;
    turnover_accrued: string;
  }>(
    `
    SELECT
      COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount ELSE -amount END), 0)::text AS balance,
      COALESCE(SUM(turnover_required_delta), 0)::text AS turnover_required,
      COALESCE(SUM(turnover_accrued_delta), 0)::text AS turnover_accrued
    FROM wallet_txs
    WHERE wallet_id = :walletId
    `,
    { replacements: { walletId }, type: QueryTypes.SELECT },
  );

  const row = rows[0];
  return {
    balance: moneyString(row?.balance ?? '0'),
    turnoverRequired: moneyString(row?.turnover_required ?? '0'),
    turnoverAccrued: moneyString(row?.turnover_accrued ?? '0'),
  };
}

function isConstraint(err: unknown, name: string): boolean {
  if (!(err instanceof DatabaseError)) return false;
  const parent = err.parent as { code?: string; constraint?: string };
  return parent?.code === '23514' && parent.constraint === name;
}
