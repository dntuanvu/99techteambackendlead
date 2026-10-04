import { randomUUID } from 'crypto';
import { Transaction, UniqueConstraintError } from 'sequelize';
import { FundingTransaction, Member, Wallet } from '../db/models';
import type { FundingStatus } from '../db/models/fundingTransaction';
import { AppError } from '../errors';
import { dec, fitsMoneyColumn, moneyString } from '../lib/money';
import { inMoneyTransaction, lockWalletById, postLedgerEntry } from './ledger';

export interface CreateDepositInput {
  memberId: string;
  amount: string;
  turnoverMultiplier: number;
}

export interface PspCallbackInput {
  pspRef: string;
  status: 'completed' | 'failed';
  amount: string;
}

export interface PspCallbackResult {
  funding: FundingTransaction;
  alreadyApplied: boolean;
}

export async function createDeposit(input: CreateDepositInput): Promise<FundingTransaction> {
  const required = dec(input.amount).times(dec(String(input.turnoverMultiplier)));
  if (!fitsMoneyColumn(required)) {
    throw new AppError(400, 'turnover_requirement_overflow');
  }

  const member = await Member.findByPk(input.memberId);
  if (!member) throw new AppError(404, 'member_not_found');

  const wallet = await Wallet.findOne({ where: { memberId: member.id } });
  if (!wallet) throw new AppError(404, 'wallet_not_found');

  return FundingTransaction.create({
    memberId: member.id,
    walletId: wallet.id,
    kind: 'deposit',
    status: 'pending',
    amount: moneyString(input.amount),
    turnoverMultiplier: input.turnoverMultiplier,
    pspRef: `psp_${randomUUID()}`,
  });
}

export async function handlePspCallback(input: PspCallbackInput): Promise<PspCallbackResult> {
  try {
    return await inMoneyTransaction((transaction) => applyCallback(input, transaction));
  } catch (err) {
    // Lost the race to insert the single credit row. Re-read the committed state.
    if (err instanceof UniqueConstraintError) {
      const funding = await FundingTransaction.findOne({ where: { pspRef: input.pspRef } });
      if (funding && funding.status === input.status && sameAmount(funding.amount, input.amount)) {
        return { funding, alreadyApplied: true };
      }
    }
    throw err;
  }
}

async function applyCallback(input: PspCallbackInput, transaction: Transaction): Promise<PspCallbackResult> {
  // Queue concurrent deliveries of this pspRef. The waiter observes the committed status.
  const funding = await FundingTransaction.findOne({
    where: { pspRef: input.pspRef },
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  if (!funding) throw new AppError(404, 'unknown_psp_ref');
  if (funding.kind !== 'deposit') throw new AppError(409, 'invalid_transition');

  const amountsMatch = sameAmount(funding.amount, input.amount);

  if (funding.status !== 'pending') {
    if (funding.status !== input.status) {
      throw new AppError(409, 'invalid_transition', { from: funding.status, to: input.status });
    }
    if (!amountsMatch) {
      throw new AppError(409, 'amount_mismatch', {
        expected: moneyString(funding.amount),
        received: moneyString(input.amount),
      });
    }
    return { funding, alreadyApplied: true };
  }

  // A mismatched callback is not applied. The deposit stays pending so a correct retry can still settle it.
  if (!amountsMatch) {
    throw new AppError(409, 'amount_mismatch', {
      expected: moneyString(funding.amount),
      received: moneyString(input.amount),
    });
  }

  if (input.status === 'failed') {
    funding.status = 'failed';
    await funding.save({ transaction });
    return { funding, alreadyApplied: false };
  }

  const wallet = await lockWalletById(funding.walletId, transaction);
  const multiplier = multiplierOf(funding);
  const credit = dec(funding.amount);
  await postLedgerEntry({
    wallet,
    kind: 'deposit',
    direction: 'credit',
    amount: credit,
    turnoverRequiredDelta: credit.times(dec(String(multiplier))),
    fundingTransactionId: funding.id,
    idempotencyKey: `deposit:${funding.id}`,
    transaction,
  });

  funding.status = 'completed' satisfies FundingStatus;
  await funding.save({ transaction });
  return { funding, alreadyApplied: false };
}

function sameAmount(stored: string, received: string): boolean {
  return dec(stored).eq(dec(received));
}

function multiplierOf(funding: FundingTransaction): number {
  const multiplier = Number(funding.turnoverMultiplier);
  if (!Number.isInteger(multiplier) || multiplier < 0) {
    throw new Error(`deposit ${funding.id} has no turnover multiplier`);
  }
  return multiplier;
}
