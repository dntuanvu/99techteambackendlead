import { Router } from 'express';
import { z } from 'zod';
import { presentFunding } from '../presenters';
import { positiveMoney, turnoverMultiplier } from '../lib/schemas';
import { createDeposit } from '../services/depositService';

export const depositsRouter = Router();

const createDepositBody = z.object({
  memberId: z.string().uuid(),
  amount: positiveMoney,
  turnoverMultiplier,
});

depositsRouter.post('/', async (req, res, next) => {
  try {
    const body = createDepositBody.parse(req.body);
    const funding = await createDeposit({
      memberId: body.memberId,
      amount: body.amount,
      turnoverMultiplier: body.turnoverMultiplier,
    });
    res.status(201).json(presentFunding(funding));
  } catch (err) {
    next(err);
  }
});
