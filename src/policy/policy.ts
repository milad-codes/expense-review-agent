import { type Category, type Receipt } from '../domain/receipt.js';
import { type Rates, REFERENCE_RATES_EUR, roundCents, toEur } from '../domain/money.js';

export type Severity = 'block' | 'review' | 'info';
export type Route = 'auto_approve' | 'auto_reject' | 'human_review';

export type FindingCode =
  | 'UNKNOWN_CURRENCY'
  | 'ALCOHOL_EXCLUDED'
  | 'NOTHING_REIMBURSABLE'
  | 'OVER_LIMIT'
  | 'MISSING_NIGHTS'
  | 'UNCATEGORIZED'
  | 'FUTURE_DATE'
  | 'SUBMITTED_TOO_LATE'
  | 'WEEKEND_EXPENSE'
  | 'MISSING_BUSINESS_PURPOSE'
  | 'DUPLICATE'
  | 'ABOVE_AUTO_APPROVAL_LIMIT'
  | 'EXTRACTION_FAILED';

export interface Finding {
  code: FindingCode;
  severity: Severity;
  message: string;
}

export interface PolicyConfig {
  autoApproveLimitEur: number;
  submissionWindowDays: number;
  mealPerPersonEur: number;
  lodgingPerNightEur: number;
  groundTransportEur: number;
  airfareEur: number;
  officeSuppliesEur: number;
  softwareEur: number;
  weekendReviewCategories: readonly Category[];
  minBusinessPurposeLength: number;
}

export const DEFAULT_POLICY: Readonly<PolicyConfig> = Object.freeze({
  autoApproveLimitEur: 250,
  submissionWindowDays: 90,
  mealPerPersonEur: 60,
  lodgingPerNightEur: 180,
  groundTransportEur: 150,
  airfareEur: 800,
  officeSuppliesEur: 200,
  softwareEur: 100,
  weekendReviewCategories: ['meal', 'ground_transport'] as const,
  minBusinessPurposeLength: 10,
});

export interface PolicyContext {
  submittedAt: Date;
  businessPurpose: string;
  /** Id of an earlier approved or pending claim with the same fingerprint, if any. */
  duplicateOf: string | null;
  rates?: Rates;
}

export interface Evaluation {
  /** Receipt total in EUR, or null if the currency is unknown. */
  amountEur: number | null;
  /** What would be paid out: total minus non-reimbursable items, in EUR. */
  reimbursableEur: number | null;
  findings: Finding[];
  route: Route;
}

const DAY_MS = 86_400_000;
const eur = (value: number): string => `€${value.toFixed(2)}`;
const utcDay = (iso: string): number => Date.parse(`${iso}T00:00:00Z`);

/** Any blocking finding rejects; any review finding needs a human; otherwise the claim is approved. */
export function routeFor(findings: readonly Finding[]): Route {
  if (findings.some((f) => f.severity === 'block')) return 'auto_reject';
  if (findings.some((f) => f.severity === 'review')) return 'human_review';
  return 'auto_approve';
}

/**
 * Applies the expense policy to an extracted receipt. Pure and deterministic: the model extracts facts,
 * this function decides. Every rule that fires explains itself in a finding.
 */
export function evaluateClaim(
  receipt: Receipt,
  ctx: PolicyContext,
  policy: PolicyConfig = DEFAULT_POLICY,
): Evaluation {
  const findings: Finding[] = [];
  const add = (code: FindingCode, severity: Severity, message: string) =>
    findings.push({ code, severity, message });
  const rates = ctx.rates ?? REFERENCE_RATES_EUR;

  if (ctx.duplicateOf) {
    add('DUPLICATE', 'block', `Same merchant, date and amount as claim ${ctx.duplicateOf}.`);
  }

  const receiptDay = utcDay(receipt.date);
  const submittedDay = utcDay(ctx.submittedAt.toISOString().slice(0, 10));
  if (receiptDay > submittedDay) {
    add('FUTURE_DATE', 'block', `The receipt date ${receipt.date} is after the submission date.`);
  } else if ((submittedDay - receiptDay) / DAY_MS > policy.submissionWindowDays) {
    add(
      'SUBMITTED_TOO_LATE',
      'block',
      `Expenses must be submitted within ${policy.submissionWindowDays} days.`,
    );
  }

  if (ctx.businessPurpose.trim().length < policy.minBusinessPurposeLength) {
    add('MISSING_BUSINESS_PURPOSE', 'review', 'The business purpose is missing or too short to assess.');
  }

  const weekday = new Date(receiptDay).getUTCDay();
  if ((weekday === 0 || weekday === 6) && policy.weekendReviewCategories.includes(receipt.category)) {
    add(
      'WEEKEND_EXPENSE',
      'review',
      `A ${receipt.category.replace('_', ' ')} expense on a weekend needs approval.`,
    );
  }

  const amountEur = toEur(receipt.total, receipt.currency, rates);
  const alcoholEur = toEur(receipt.alcoholAmount, receipt.currency, rates);
  if (amountEur === null || alcoholEur === null) {
    add(
      'UNKNOWN_CURRENCY',
      'review',
      `No exchange rate for ${receipt.currency}; the amount must be checked manually.`,
    );
    return { amountEur: null, reimbursableEur: null, findings, route: routeFor(findings) };
  }

  const reimbursableEur = roundCents(Math.max(0, amountEur - alcoholEur));
  if (alcoholEur > 0) {
    add('ALCOHOL_EXCLUDED', 'info', `${eur(alcoholEur)} of alcohol is not reimbursable and was deducted.`);
  }
  if (reimbursableEur === 0) {
    add('NOTHING_REIMBURSABLE', 'block', 'Nothing on this receipt is reimbursable.');
    return { amountEur, reimbursableEur, findings, route: routeFor(findings) };
  }

  checkCategoryLimit(receipt, reimbursableEur, policy, add);

  if (reimbursableEur > policy.autoApproveLimitEur) {
    add(
      'ABOVE_AUTO_APPROVAL_LIMIT',
      'review',
      `${eur(reimbursableEur)} is above the ${eur(policy.autoApproveLimitEur)} automatic approval limit.`,
    );
  }

  return { amountEur, reimbursableEur, findings, route: routeFor(findings) };
}

function checkCategoryLimit(
  receipt: Receipt,
  reimbursableEur: number,
  policy: PolicyConfig,
  add: (code: FindingCode, severity: Severity, message: string) => void,
): void {
  const over = (amount: number, limit: number, unit: string) =>
    add(
      'OVER_LIMIT',
      'review',
      `${eur(amount)}${unit} exceeds the ${eur(limit)}${unit} limit for ${receipt.category.replace('_', ' ')}.`,
    );

  switch (receipt.category) {
    case 'meal': {
      const allowance = roundCents(policy.mealPerPersonEur * receipt.attendees);
      if (reimbursableEur > allowance) {
        add(
          'OVER_LIMIT',
          'review',
          `${eur(reimbursableEur)} exceeds the ${eur(allowance)} total meal allowance ` +
            `(${eur(policy.mealPerPersonEur)} per person for ${receipt.attendees} people).`,
        );
      }
      return;
    }
    case 'lodging': {
      if (receipt.nights < 1) {
        add(
          'MISSING_NIGHTS',
          'review',
          'The number of nights could not be determined for this lodging receipt.',
        );
        return;
      }
      const allowance = roundCents(policy.lodgingPerNightEur * receipt.nights);
      if (reimbursableEur > allowance) {
        add(
          'OVER_LIMIT',
          'review',
          `${eur(reimbursableEur)} exceeds the ${eur(allowance)} total lodging allowance ` +
            `(${eur(policy.lodgingPerNightEur)} per night for ${receipt.nights} nights).`,
        );
      }
      return;
    }
    case 'ground_transport':
      if (reimbursableEur > policy.groundTransportEur) over(reimbursableEur, policy.groundTransportEur, '');
      return;
    case 'airfare':
      if (reimbursableEur > policy.airfareEur) over(reimbursableEur, policy.airfareEur, '');
      return;
    case 'office_supplies':
      if (reimbursableEur > policy.officeSuppliesEur) over(reimbursableEur, policy.officeSuppliesEur, '');
      return;
    case 'software':
      if (reimbursableEur > policy.softwareEur) over(reimbursableEur, policy.softwareEur, '');
      return;
    case 'other':
      add('UNCATEGORIZED', 'review', 'There is no automatic rule for this category.');
      return;
  }
}
