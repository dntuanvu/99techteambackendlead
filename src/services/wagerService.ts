import { randomUUID } from 'crypto';
import { Wallet, WalletTx } from '../db/models';
import { dec } from '../lib/money';
import { inMoneyTransaction, lockWalletById, postLedgerEntry } from './ledger';

export async function placeWager(
  walletId: string,
  amount: string,
): Promise<{ wallet: Wallet; entry: WalletTx }> {
  const stake = dec(amount);
  return inMoneyTransaction(async (transaction) => {
    const wallet = await lockWalletById(walletId, transaction);
    const entry = await postLedgerEntry({
      wallet,
      kind: 'wager',
      direction: 'debit',
      amount: stake,
      turnoverAccruedDelta: stake,
      fundingTransactionId: null,
      idempotencyKey: `wager:${randomUUID()}`,
      transaction,
    });
    return { wallet, entry };
  });
}
