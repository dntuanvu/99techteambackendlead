import BigNumber from 'bignumber.js';

// Money invariants for this codebase:
// - Money is stored as DECIMAL(36,18) in Postgres and travels as strings in JS/JSON.
// - All arithmetic on money MUST go through BigNumber. Never use JS number math on money.
BigNumber.config({ DECIMAL_PLACES: 18, ROUNDING_MODE: BigNumber.ROUND_DOWN });

export function dec(value: string | number | BigNumber): BigNumber {
  const bn = new BigNumber(value);
  if (!bn.isFinite()) {
    throw new Error(`Invalid money value: ${value}`);
  }
  return bn;
}

export const ZERO = dec(0);

/** DECIMAL(36,18) stores 18 fractional digits and 18 integer digits, so values must be < 10^18. */
export const MONEY_CEILING = dec(10).pow(18);

export function moneyString(value: string | number | BigNumber): string {
  return dec(value).toFixed(18);
}

export function fitsMoneyColumn(value: BigNumber): boolean {
  return value.isFinite() && !value.isNegative() && value.isLessThan(MONEY_CEILING);
}
