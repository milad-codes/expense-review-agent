import type { Receipt } from '../src/domain/receipt.js';
import type { PolicyContext } from '../src/policy/policy.js';

/** A Tuesday lunch for two, comfortably inside every limit. */
export const lunch = (overrides: Partial<Receipt> = {}): Receipt => ({
  merchant: 'Café Luitpold',
  date: '2026-10-20',
  currency: 'EUR',
  total: 48.6,
  category: 'meal',
  attendees: 2,
  nights: 0,
  alcoholAmount: 0,
  ...overrides,
});

export const context = (overrides: Partial<PolicyContext> = {}): PolicyContext => ({
  submittedAt: new Date('2026-10-22T09:00:00Z'),
  businessPurpose: 'Customer workshop follow-up with ACME',
  duplicateOf: null,
  ...overrides,
});
