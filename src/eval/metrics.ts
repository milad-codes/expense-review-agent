import type { Receipt } from '../domain/receipt.js';

export interface CaseResult {
  id: string;
  expectedRoute: string;
  actualRoute: string | null;
  expectedFindings: string[];
  actualFindings: string[];
  expectedReadable: boolean;
  actualReadable: boolean;
  /** Per-field match of the extracted receipt; empty when either side is unreadable. */
  fieldMatches: Partial<Record<keyof Receipt, boolean>>;
  latencyMs: number;
  error: string | null;
}

export interface Summary {
  cases: number;
  routeAccuracy: number;
  findings: { precision: number; recall: number; f1: number };
  readableAccuracy: number;
  fieldAccuracy: Partial<Record<keyof Receipt, number>>;
  latencyMs: { p50: number; p95: number; max: number };
  errors: number;
}

const ratio = (num: number, den: number): number => (den === 0 ? 1 : num / den);

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? 0;
}

/** Field comparison used for extraction accuracy: amounts within a cent, merchants case/accent-insensitive. */
export function compareReceipts(expected: Receipt, actual: Receipt): Partial<Record<keyof Receipt, boolean>> {
  const norm = (s: string) =>
    s
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  const money = (a: number, b: number) => Math.abs(a - b) < 0.01;
  return {
    merchant:
      norm(actual.merchant).includes(norm(expected.merchant)) ||
      norm(expected.merchant).includes(norm(actual.merchant)),
    date: expected.date === actual.date,
    currency: expected.currency === actual.currency,
    total: money(expected.total, actual.total),
    category: expected.category === actual.category,
    attendees: expected.attendees === actual.attendees,
    nights: expected.nights === actual.nights,
    alcoholAmount: money(expected.alcoholAmount, actual.alcoholAmount),
  };
}

export function summarize(results: CaseResult[]): Summary {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (const r of results) {
    const expected = new Set(r.expectedFindings);
    const actual = new Set(r.actualFindings);
    for (const code of actual) {
      if (expected.has(code)) tp += 1;
      else fp += 1;
    }
    for (const code of expected) if (!actual.has(code)) fn += 1;
  }
  const precision = ratio(tp, tp + fp);
  const recall = ratio(tp, tp + fn);
  const fieldAccuracy: Partial<Record<keyof Receipt, number>> = {};
  const withFields = results.filter((r) => Object.keys(r.fieldMatches).length > 0);
  for (const field of [
    'merchant',
    'date',
    'currency',
    'total',
    'category',
    'attendees',
    'nights',
    'alcoholAmount',
  ] as const) {
    if (withFields.length)
      fieldAccuracy[field] = ratio(withFields.filter((r) => r.fieldMatches[field]).length, withFields.length);
  }
  const latencies = results.map((r) => r.latencyMs);
  return {
    cases: results.length,
    routeAccuracy: ratio(results.filter((r) => r.actualRoute === r.expectedRoute).length, results.length),
    findings: {
      precision,
      recall,
      f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
    },
    readableAccuracy: ratio(
      results.filter((r) => r.actualReadable === r.expectedReadable).length,
      results.length,
    ),
    fieldAccuracy,
    latencyMs: {
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      max: Math.max(0, ...latencies),
    },
    errors: results.filter((r) => r.error).length,
  };
}
