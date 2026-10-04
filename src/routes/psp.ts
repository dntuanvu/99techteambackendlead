import { Router } from 'express';
import { z } from 'zod';
import { moneyString } from '../lib/money';
import { positiveMoney } from '../lib/schemas';
import { handlePspCallback } from '../services/depositService';

// This route is the mock provider. A new PSP should verify and normalize into
// the same shape before calling handlePspCallback. See DESIGN-PSP.md.

export const pspRouter = Router();

const callbackBody = z.object({
  pspRef: z.string().min(1).max(128),
  status: z.enum(['completed', 'failed']),
  amount: positiveMoney,
});

pspRouter.post('/callbacks', async (req, res, next) => {
  try {
    const body = callbackBody.parse(req.body);
    const { funding, alreadyApplied } = await handlePspCallback(body);
    res.status(200).json({
      id: funding.id,
      pspRef: funding.pspRef,
      status: funding.status,
      amount: moneyString(funding.amount),
      alreadyApplied,
    });
  } catch (err) {
    next(err);
  }
});
