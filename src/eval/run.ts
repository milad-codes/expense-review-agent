/* eslint-disable no-console */
// Evaluation harness: `npm run eval -- --extractor gold|llm [--dataset path] [--min-route-accuracy 0.9] [--min-finding-f1 0.9]`
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { MemorySaver } from '@langchain/langgraph';
import { z } from 'zod';
import { loadEnv } from '../config.js';
import { type Receipt, ReceiptSchema } from '../domain/receipt.js';
import { ExtractionError, type ReceiptExtractor } from '../extraction/extractor.js';
import { LlmReceiptExtractor } from '../extraction/llm-extractor.js';
import { createChatModel } from '../extraction/models.js';
import { compileReviewGraph } from '../graph/graph.js';
import { silentLogger } from '../logger.js';
import { ReviewService } from '../review-service.js';
import { InMemoryClaimStore } from '../store/claim-store.js';
import { type CaseResult, compareReceipts, summarize } from './metrics.js';

const CaseSchema = z.object({
  id: z.string(),
  input: z.object({ employeeId: z.string(), businessPurpose: z.string(), receiptText: z.string() }),
  submittedAt: z.iso.datetime(),
  expected: z.object({
    readable: z.boolean(),
    receipt: ReceiptSchema.nullable(),
    route: z.enum(['auto_approve', 'auto_reject', 'human_review']),
    findings: z.array(z.string()),
  }),
});
type Case = z.infer<typeof CaseSchema>;

/** Replays the labelled receipts: isolates policy + workflow from extraction quality. */
class GoldExtractor implements ReceiptExtractor {
  constructor(private readonly byText: Map<string, Case>) {}
  async extract(receiptText: string): Promise<Receipt> {
    const c = this.byText.get(receiptText);
    if (!c?.expected.receipt) throw new ExtractionError('labelled as unreadable');
    return c.expected.receipt;
  }
}

/** Records what the real extractor returned so it can be scored per field. */
class RecordingExtractor implements ReceiptExtractor {
  readonly outputs = new Map<string, Receipt | null>();
  constructor(private readonly inner: ReceiptExtractor) {}
  async extract(receiptText: string): Promise<Receipt> {
    try {
      const receipt = await this.inner.extract(receiptText);
      this.outputs.set(receiptText, receipt);
      return receipt;
    } catch (error) {
      if (error instanceof ExtractionError) this.outputs.set(receiptText, null);
      throw error;
    }
  }
}

const { values: args } = parseArgs({
  options: {
    extractor: { type: 'string', default: 'gold' },
    dataset: { type: 'string', default: 'evals/claims.jsonl' },
    'min-route-accuracy': { type: 'string', default: '0' },
    'min-finding-f1': { type: 'string', default: '0' },
    out: { type: 'string', default: 'evals/results' },
  },
});

const cases = readFileSync(args.dataset, 'utf8')
  .split('\n')
  .filter((line) => line.trim())
  .map((line) => CaseSchema.parse(JSON.parse(line)));

let extractor: ReceiptExtractor;
let model = 'gold';
if (args.extractor === 'gold') {
  extractor = new GoldExtractor(new Map(cases.map((c) => [c.input.receiptText, c])));
} else if (args.extractor === 'llm') {
  const env = loadEnv();
  model = `${env.LLM_PROVIDER}:${env.LLM_MODEL}`;
  extractor = new LlmReceiptExtractor(createChatModel(env), { maxAttempts: env.EXTRACTION_MAX_ATTEMPTS });
} else {
  throw new Error(`unknown extractor ${args.extractor}`);
}
const recording = new RecordingExtractor(extractor);

let clock = new Date();
const store = new InMemoryClaimStore();
const graph = compileReviewGraph(
  { extractor: recording, store, logger: silentLogger, now: () => clock },
  new MemorySaver(),
);
const service = new ReviewService(graph, store, { now: () => clock });

const results: CaseResult[] = [];
for (const c of cases) {
  clock = new Date(c.submittedAt);
  const started = performance.now();
  let error: string | null = null;
  let route: string | null = null;
  let findings: string[] = [];
  try {
    const view = await service.submit(c.input);
    route = view.evaluation?.route ?? null;
    findings = view.evaluation?.findings.map((f) => f.code) ?? [];
  } catch (e) {
    error = (e as Error).message;
  }
  const extracted = recording.outputs.get(c.input.receiptText) ?? null;
  results.push({
    id: c.id,
    expectedRoute: c.expected.route,
    actualRoute: route,
    expectedFindings: c.expected.findings,
    actualFindings: findings,
    expectedReadable: c.expected.readable,
    actualReadable: extracted !== null,
    fieldMatches: c.expected.receipt && extracted ? compareReceipts(c.expected.receipt, extracted) : {},
    latencyMs: Math.round(performance.now() - started),
    error,
  });
}

const summary = summarize(results);
const pct = (n: number) => `${(n * 100).toFixed(1)} %`;
console.log(`\nEvaluation (${model}, ${summary.cases} cases)\n`);
console.log('| metric | value |\n| --- | --- |');
console.log(`| route accuracy | ${pct(summary.routeAccuracy)} |`);
console.log(
  `| finding precision / recall / F1 | ${pct(summary.findings.precision)} / ${pct(summary.findings.recall)} / ${pct(summary.findings.f1)} |`,
);
console.log(`| readable / unreadable correct | ${pct(summary.readableAccuracy)} |`);
for (const [field, acc] of Object.entries(summary.fieldAccuracy))
  console.log(`| field: ${field} | ${pct(acc)} |`);
console.log(
  `| latency p50 / p95 / max | ${summary.latencyMs.p50} / ${summary.latencyMs.p95} / ${summary.latencyMs.max} ms |`,
);
console.log(`| errors | ${summary.errors} |`);

const misses = results.filter(
  (r) =>
    r.actualRoute !== r.expectedRoute ||
    [...r.expectedFindings].sort().join() !== [...r.actualFindings].sort().join(),
);
for (const r of misses) {
  console.log(
    `\n✗ ${r.id}: route ${r.actualRoute} (expected ${r.expectedRoute}); findings [${r.actualFindings}] (expected [${r.expectedFindings}])${r.error ? `; error: ${r.error}` : ''}`,
  );
}

mkdirSync(args.out, { recursive: true });
const file = join(args.out, `${new Date().toISOString().replace(/[:.]/g, '-')}-${args.extractor}.json`);
writeFileSync(file, `${JSON.stringify({ model, dataset: args.dataset, summary, results }, null, 2)}\n`);
console.log(`\nresults: ${file}`);

const minRoute = Number(args['min-route-accuracy']);
const minF1 = Number(args['min-finding-f1']);
if (summary.routeAccuracy < minRoute || summary.findings.f1 < minF1) {
  console.error(
    `\nFAILED: route accuracy ${pct(summary.routeAccuracy)} (min ${pct(minRoute)}), finding F1 ${pct(summary.findings.f1)} (min ${pct(minF1)})`,
  );
  process.exit(1);
}
