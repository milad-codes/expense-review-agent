/* eslint-disable no-console -- a command-line walkthrough prints its steps */
// Runs three synthetic expense claims through the real workflow, restarts in the middle, and lets a reviewer decide.
// No model is called: labelled extraction stands in for the LLM, so it needs no API key. The policy, the LangGraph
// workflow with SQLite checkpoints, the claim store and the HTTP API are the real ones (Fastify inject, no port).
//   npm run demo
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import type { Receipt } from '../src/domain/receipt.js';
import { ExtractionError, type ReceiptExtractor } from '../src/extraction/extractor.js';
import { compileReviewGraph } from '../src/graph/graph.js';
import { buildApp } from '../src/http/app.js';
import { silentLogger } from '../src/logger.js';
import { ReviewService } from '../src/review-service.js';
import { SqliteClaimStore } from '../src/store/sqlite-claim-store.js';

const now = () => new Date('2026-10-22T09:00:00Z'); // a Thursday; receipts are from earlier that week
const reviewToken = 'demo-reviewer-token-not-secret';

const claims: {
  title: string;
  employeeId: string;
  businessPurpose: string;
  receiptText: string;
  receipt: Receipt;
}[] = [
  {
    title: 'team lunch',
    employeeId: 'emp-1',
    businessPurpose: 'Lunch with the project team after the sprint review',
    receiptText:
      'CAFÉ AM BEISPIELPLATZ\n20.10.2026 12:41\n2x Mittagsmenü 43,80\n2x Wasser 4,80\nSUMME EUR 48,60',
    receipt: {
      merchant: 'Café am Beispielplatz',
      date: '2026-10-20',
      currency: 'EUR',
      total: 48.6,
      category: 'meal',
      attendees: 2,
      nights: 0,
      alcoholAmount: 0,
    },
  },
  {
    title: 'client dinner',
    employeeId: 'emp-2',
    businessPurpose: 'Dinner with the customer to close the integration contract',
    receiptText:
      'RESTAURANT ZUM MUSTERHOF\n21.10.2026 Gäste: 2\n2x Menü 340,00\n2x Wasser 16,00\nTrinkgeld 24,00\nGESAMT EUR 380,00',
    receipt: {
      merchant: 'Restaurant zum Musterhof',
      date: '2026-10-21',
      currency: 'EUR',
      total: 380,
      category: 'meal',
      attendees: 2,
      nights: 0,
      alcoholAmount: 0,
    },
  },
  {
    title: 'drinks only',
    employeeId: 'emp-3',
    businessPurpose: 'Drinks after the team offsite',
    receiptText: 'BIERSTUBE BEISPIEL\n16.10.2026 22:40\n4x Helles 0,5l 24,00\nSumme EUR 24,00',
    receipt: {
      merchant: 'Bierstube Beispiel',
      date: '2026-10-16',
      currency: 'EUR',
      total: 24,
      category: 'meal',
      attendees: 1,
      nights: 0,
      alcoholAmount: 24,
    },
  },
];

/** Returns the labelled receipt for each synthetic text: the stand-in for the LLM extractor. */
class LabelledExtractor implements ReceiptExtractor {
  private readonly byText = new Map(claims.map((c) => [c.receiptText, c.receipt]));
  async extract(receiptText: string): Promise<Receipt> {
    const receipt = this.byText.get(receiptText);
    if (!receipt) throw new ExtractionError('not a demo receipt');
    return receipt;
  }
}

function start(dir: string) {
  const store = new SqliteClaimStore(join(dir, 'claims.sqlite'));
  const checkpointer = SqliteSaver.fromConnString(join(dir, 'checkpoints.sqlite'));
  const graph = compileReviewGraph(
    { extractor: new LabelledExtractor(), store, logger: silentLogger, now },
    checkpointer,
  );
  const app = buildApp({ service: new ReviewService(graph, store, { now }), reviewToken });
  return {
    app,
    close: async () => {
      await app.close();
      store.close();
    },
  };
}

const reviewer = { authorization: `Bearer ${reviewToken}` };
const dir = mkdtempSync(join(tmpdir(), 'expense-review-demo-'));
try {
  let service = start(dir);
  let waiting = '';
  for (const c of claims) {
    const res = await service.app.inject({
      method: 'POST',
      url: '/claims',
      payload: { employeeId: c.employeeId, businessPurpose: c.businessPurpose, receiptText: c.receiptText },
    });
    const view = res.json();
    const findings = view.evaluation?.findings.map((f: { code: string }) => f.code).join(', ') || 'none';
    console.log(`${c.title.padEnd(14)} → ${view.status.padEnd(12)} findings: ${findings}`);
    if (view.status === 'needs_review') waiting = view.claimId;
  }

  console.log('\nrestarting: closing the API and the SQLite files, then opening them again …');
  await service.close();
  service = start(dir);

  const pending = (
    await service.app.inject({ method: 'GET', url: '/reviews/pending', headers: reviewer })
  ).json();
  console.log(
    `pending after restart: ${pending.map((p: { claimId: string; amountEur: number }) => `${p.claimId} (€${p.amountEur})`).join(', ')}`,
  );

  const decided = await service.app.inject({
    method: 'POST',
    url: `/claims/${waiting}/review`,
    headers: reviewer,
    payload: {
      decision: 'approve',
      reviewer: 'Demo Reviewer',
      comment: 'Contract dinner, approved by the budget owner',
    },
  });
  const final = decided.json();
  console.log(`reviewer approves → ${final.status}`);
  console.log(`audit trail: ${final.events.map((e: { step: string }) => e.step).join(' → ')}`);
  await service.close();
} finally {
  rmSync(dir, { recursive: true, force: true });
}
