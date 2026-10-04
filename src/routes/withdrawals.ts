import { Router } from 'express';
import { z } from 'zod';
import { moneyString } from '../lib/money';
import { positiveMoney } from '../lib/schemas';
import { presentFunding } from '../presenters';
import { requestWithdrawal } from '../services/withdrawalService';

export const withdrawalsRouter = Router();

const withdrawalBody = z.object({
  memberId: z.string().uuid(),
  amount: positiveMoney,
});

withdrawalsRouter.post('/', async (req, res, next) => {
  try {
    const body = withdrawalBody.parse(req.body);
    const { wallet, funding } = await requestWithdrawal(body.memberId, body.amount);
    res.status(201).json({
      ...presentFunding(funding),
      balance: moneyString(wallet.balance),
    });
  } catch (err) {
    next(err);
  }
});
