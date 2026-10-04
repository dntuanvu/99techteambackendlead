import { FundingTransaction, Member, Wallet } from '../db/models';
import { AppError } from '../errors';
import { dec, moneyString } from '../lib/money';
import { inMoneyTransaction, lockWalletByMemberId, postLedgerEntry } from './ledger';

export async function requestWithdrawal(
  memberId: string,
  amount: string,
): Promise<{ wallet: Wallet; funding: FundingTransaction }> {
  const value = dec(amount);

  return inMoneyTransaction(async (transaction) => {
    const member = await Member.findByPk(memberId, { transaction });
    if (!member) throw new AppError(404, 'member_not_found');

    const wallet = await lockWalletByMemberId(member.id, transaction);
    const required = dec(wallet.turnoverRequired);
    const accrued = dec(wallet.turnoverAccrued);
    // Turnover is the first gate. A member who is short on playthrough should see that
    // even when the requested amount is also larger than the balance.
    if (accrued.isLessThan(required)) {
      throw new AppError(422, 'turnover_requirement_not_met', {
        turnoverRequired: moneyString(required),
        turnoverAccrued: moneyString(accrued),
        turnoverOutstanding: moneyString(required.minus(accrued)),
      });
    }

    if (dec(wallet.balance).isLessThan(value)) {
      throw new AppError(422, 'insufficient_balance', {
        balance: moneyString(wallet.balance),
        amount: moneyString(value),
      });
    }

    const funding = await FundingTransaction.create(
      {
        memberId: member.id,
        walletId: wallet.id,
        kind: 'withdrawal',
        status: 'pending',
        amount: moneyString(value),
        turnoverMultiplier: null,
        pspRef: null,
      },
      { transaction },
    );

    await postLedgerEntry({
      wallet,
      kind: 'withdrawal',
      direction: 'debit',
      amount: value,
      fundingTransactionId: funding.id,
      idempotencyKey: `withdrawal:${funding.id}`,
      transaction,
    });

    return { wallet, funding };
  });
}
