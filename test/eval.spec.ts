import { readFileSync } from 'node:fs';
import { totalIsGrounded } from '../src/extraction/llm-extractor.js';
import { type CaseResult, compareReceipts, percentile, summarize } from '../src/eval/metrics.js';
import { lunch } from './fixtures.js';

const result = (overrides: Partial<CaseResult>): CaseResult => ({
  id: 'x',
  expectedRoute: 'auto_approve',
  actualRoute: 'auto_approve',
  expectedFindings: [],
  actualFindings: [],
  expectedReadable: true,
  actualReadable: true,
  fieldMatches: {},
  latencyMs: 10,
  error: null,
  ...overrides,
});

describe('evaluation metrics', () => {
  it('computes route accuracy and micro precision/recall over finding codes', () => {
    const summary = summarize([
      result({ expectedFindings: ['A'], actualFindings: ['A', 'B'] }),
      result({
        expectedRoute: 'human_review',
        actualRoute: 'auto_approve',
        expectedFindings: ['C'],
        actualFindings: [],
      }),
    ]);
    expect(summary.routeAccuracy).toBe(0.5);
    expect(summary.findings.precision).toBe(0.5);
    expect(summary.findings.recall).toBe(0.5);
  });

  it('uses nearest-rank percentiles', () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([5, 1, 3, 2, 4], 95)).toBe(5);
    expect(percentile([], 95)).toBe(0);
  });

  it('compares receipts with tolerance for amounts and merchant spelling', () => {
    const matches = compareReceipts(
      lunch(),
      lunch({ merchant: 'CAFE LUITPOLD GmbH', total: 48.604, nights: 1 }),
    );
    expect(matches).toMatchObject({ merchant: true, total: true, nights: false });
  });
});

describe('evaluation dataset', () => {
  const cases = readFileSync('evals/claims.jsonl', 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(
      (line) =>
        JSON.parse(line) as {
          id: string;
          input: { receiptText: string };
          expected: { receipt: { total: number } | null };
        },
    );

  it('has unique ids', () => {
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
  });

  it.each(cases.filter((c) => c.expected.receipt).map((c) => [c.id, c] as const))(
    'labels a total that is printed on the receipt (%s)',
    (_id, c) => {
      expect(totalIsGrounded(c.input.receiptText, c.expected.receipt!.total)).toBe(true);
    },
  );
});
