/* eslint-disable no-console */
// Two different measurements share this harness:
//
//   npm run eval -- --extractor gold
//     Policy and workflow regression. The labelled receipts replace the model, so nothing about extraction is
//     measured. Deterministic and free; CI requires 100 % here.
//
//   npm run eval -- --extractor llm --max-cost-usd 1 --input-usd-per-mtok <price> --output-usd-per-mtok <price>
//     Real model calls: extraction accuracy per field, routing and findings end to end, latency, tokens and cost.
//     Refuses to start without a spending limit and the provider's current prices, and stops before a case could
//     exceed the limit.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { MemorySaver } from '@langchain/langgraph';
import { z } from 'zod';
import { loadLlmEnv } from '../config.js';
import { type Receipt, ReceiptSchema } from '../domain/receipt.js';
import { ExtractionError, type ReceiptExtractor } from '../extraction/extractor.js';
import { LlmReceiptExtractor, promptChars } from '../extraction/llm-extractor.js';
import { createChatModel, DEFAULT_MAX_OUTPUT_TOKENS } from '../extraction/models.js';
import { compileReviewGraph } from '../graph/graph.js';
import { silentLogger } from '../logger.js';
import { ReviewService } from '../review-service.js';
import { InMemoryClaimStore } from '../store/claim-store.js';
import { Budget, costUsd, UsageMeter, worstCaseCall } from './budget.js';
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
    'max-cost-usd': { type: 'string' },
    'input-usd-per-mtok': { type: 'string' },
    'output-usd-per-mtok': { type: 'string' },
    'max-output-tokens': { type: 'string', default: String(DEFAULT_MAX_OUTPUT_TOKENS) },
    out: { type: 'string', default: 'evals/results' },
  },
});

function positiveNumber(name: string): number {
  const value = Number(args[name as keyof typeof args]);
  if (!Number.isFinite(value) || value <= 0) {
    console.error(
      `--${name} is required for --extractor llm and must be a positive number.\n` +
        'Look up the current per-million-token prices of your model on the provider pricing page, then run e.g.\n' +
        '  npm run eval -- --extractor llm --max-cost-usd 1 --input-usd-per-mtok 0.15 --output-usd-per-mtok 0.6',
    );
    process.exit(2);
  }
  return value;
}

const cases = readFileSync(args.dataset, 'utf8')
  .split('\n')
  .filter((line) => line.trim())
  .map((line) => CaseSchema.parse(JSON.parse(line)));

const llm = args.extractor === 'llm';
if (!llm && args.extractor !== 'gold') throw new Error(`unknown extractor ${args.extractor}`);

let extractor: ReceiptExtractor;
let model = 'gold labels (no model)';
let budget: Budget | null = null;
let maxAttempts = 1;
const maxOutputTokens = Number(args['max-output-tokens']);
if (llm) {
  const limits = {
    maxUsd: positiveNumber('max-cost-usd'),
    inputUsdPerMTok: positiveNumber('input-usd-per-mtok'),
    outputUsdPerMTok: positiveNumber('output-usd-per-mtok'),
  };
  let env: ReturnType<typeof loadLlmEnv>;
  try {
    env = loadLlmEnv();
  } catch (error) {
    console.error(
      `${(error as Error).message}\nSet LLM_PROVIDER, LLM_MODEL and the provider's API key (see .env.example).`,
    );
    process.exit(2);
  }
  const meter = new UsageMeter();
  budget = new Budget(
    limits.maxUsd,
    { inputUsdPerMTok: limits.inputUsdPerMTok, outputUsdPerMTok: limits.outputUsdPerMTok },
    meter,
  );
  model = `${env.LLM_PROVIDER}:${env.LLM_MODEL}`;
  maxAttempts = env.EXTRACTION_MAX_ATTEMPTS;
  extractor = new LlmReceiptExtractor(
    createChatModel(env, { maxTokens: maxOutputTokens, callbacks: [meter] }),
    { maxAttempts },
  );
} else {
  extractor = new GoldExtractor(new Map(cases.map((c) => [c.input.receiptText, c])));
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
let stoppedEarly: string | null = null;
for (const c of cases) {
  if (budget) {
    const call = worstCaseCall(promptChars(c.input.receiptText), maxOutputTokens);
    const worstCase = {
      inputTokens: call.inputTokens * maxAttempts,
      outputTokens: call.outputTokens * maxAttempts,
    };
    if (!budget.canAfford(worstCase)) {
      stoppedEarly =
        budget.meter.unreported > 0
          ? 'the provider did not report token usage, so the cost cannot be tracked'
          : `case ${c.id} could exceed the $${budget.maxUsd} limit (spent so far $${budget.spentUsd().toFixed(4)})`;
      break;
    }
  }
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
const title = llm
  ? `LLM evaluation (${model}, ${summary.cases} of ${cases.length} cases)`
  : `Policy and workflow regression (${summary.cases} cases; gold labels replace the model, extraction is not measured)`;
console.log(`\n${title}\n`);
console.log('| metric | value |\n| --- | --- |');
console.log(`| route accuracy | ${pct(summary.routeAccuracy)} |`);
console.log(
  `| finding precision / recall / F1 | ${pct(summary.findings.precision)} / ${pct(summary.findings.recall)} / ${pct(summary.findings.f1)} |`,
);
if (llm) {
  console.log(`| readable / unreadable correct | ${pct(summary.readableAccuracy)} |`);
  for (const [field, acc] of Object.entries(summary.fieldAccuracy))
    console.log(`| field: ${field} | ${pct(acc)} |`);
}
console.log(
  `| latency p50 / p95 / max | ${summary.latencyMs.p50} / ${summary.latencyMs.p95} / ${summary.latencyMs.max} ms |`,
);
console.log(`| errors | ${summary.errors} |`);
const usage = budget
  ? {
      calls: budget.meter.calls,
      inputTokens: budget.meter.inputTokens,
      outputTokens: budget.meter.outputTokens,
      unreportedCalls: budget.meter.unreported,
      prices: budget.prices,
      maxCostUsd: budget.maxUsd,
      costUsd: Number(costUsd(budget.meter, budget.prices).toFixed(6)),
    }
  : null;
if (usage) {
  console.log(`| model calls | ${usage.calls} |`);
  console.log(`| tokens in / out | ${usage.inputTokens} / ${usage.outputTokens} |`);
  console.log(`| cost (from reported tokens and the given prices) | $${usage.costUsd.toFixed(4)} |`);
}

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
if (stoppedEarly) console.log(`\nStopped early: ${stoppedEarly}.`);

mkdirSync(args.out, { recursive: true });
const file = join(args.out, `${new Date().toISOString().replace(/[:.]/g, '-')}-${args.extractor}.json`);
writeFileSync(
  file,
  `${JSON.stringify(
    {
      mode: llm ? 'llm-evaluation' : 'gold-regression',
      model,
      dataset: args.dataset,
      ranAt: new Date().toISOString(),
      stoppedEarly,
      usage,
      summary,
      results,
    },
    null,
    2,
  )}\n`,
);
console.log(`\nresults: ${file}`);

const minRoute = Number(args['min-route-accuracy']);
const minF1 = Number(args['min-finding-f1']);
if (stoppedEarly) process.exit(3);
if (summary.routeAccuracy < minRoute || summary.findings.f1 < minF1) {
  console.error(
    `\nFAILED: route accuracy ${pct(summary.routeAccuracy)} (min ${pct(minRoute)}), finding F1 ${pct(summary.findings.f1)} (min ${pct(minF1)})`,
  );
  process.exit(1);
}
