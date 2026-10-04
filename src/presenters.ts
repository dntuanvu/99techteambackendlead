import { FundingTransaction } from './db/models';
import { moneyString } from './lib/money';

export function presentFunding(funding: FundingTransaction) {
  return {
    id: funding.id,
    memberId: funding.memberId,
    walletId: funding.walletId,
    kind: funding.kind,
    status: funding.status,
    amount: moneyString(funding.amount),
    turnoverMultiplier: funding.turnoverMultiplier,
    pspRef: funding.pspRef,
  };
}
