/** Exchange rates to EUR (units of EUR per 1 unit of the currency). */
export type Rates = Readonly<Record<string, number>>;

/**
 * Fixed reference rates for the demo and the tests. A deployment would load daily reference rates
 * (e.g. the ECB feed) behind the same shape.
 */
export const REFERENCE_RATES_EUR: Rates = Object.freeze({
  EUR: 1,
  USD: 0.92,
  GBP: 1.17,
  CHF: 1.04,
  TRY: 0.027,
  PLN: 0.23,
});

/** Rounds to cents using integer arithmetic so sums do not drift. */
export const roundCents = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

export function toEur(amount: number, currency: string, rates: Rates = REFERENCE_RATES_EUR): number | null {
  const rate = rates[currency];
  return rate === undefined ? null : roundCents(amount * rate);
}
