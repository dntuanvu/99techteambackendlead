import { z } from 'zod';
import { dec } from './money';

// Money stays a string at the boundary. The regex also rejects exponents and
// more than 18 fractional digits so we never round a value the client sent.
export const positiveMoney = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,17})(?:\.\d{1,18})?$/, 'invalid money format')
  .refine((value) => dec(value).isGreaterThan(0), { message: 'amount must be positive' });

export const turnoverMultiplier = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(1);
