import type { Receipt } from '../domain/receipt.js';

/** Normalised merchant, date and amount: equal fingerprints for the same employee indicate a duplicate claim. */
export function claimFingerprint(
  employeeId: string,
  receipt: Pick<Receipt, 'merchant' | 'date' | 'total' | 'currency'>,
): string {
  const merchant = receipt.merchant
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  const cents = Math.round(receipt.total * 100);
  return [employeeId, merchant, receipt.date, `${cents}${receipt.currency}`].join('|');
}
