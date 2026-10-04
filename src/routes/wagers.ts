import { Router } from 'express';
import { z } from 'zod';
import { moneyString } from '../lib/money';
import { positiveMoney } from '../lib/schemas';
import { placeWager } from '../services/wagerService';

export const walletsRouter = Router();

const wagerBody = z.object({
  amount: positiveMoney,
});

walletsRouter.post('/:walletId/wagers', async (req, res, next) => {
  try {
    const walletId = z.string().uuid().parse(req.params.walletId);
    const body = wagerBody.parse(req.body);
    const { wallet, entry } = await placeWager(walletId, body.amount);
    res.status(201).json({
      id: entry.id,
      walletId: wallet.id,
      amount: moneyString(entry.amount),
      balance: moneyString(wallet.balance),
      turnoverRequired: moneyString(wallet.turnoverRequired),
      turnoverAccrued: moneyString(wallet.turnoverAccrued),
    });
  } catch (err) {
    next(err);
  }
});
