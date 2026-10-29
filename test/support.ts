import { MemorySaver } from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph';
import type { Receipt } from '../src/domain/receipt.js';
import { ExtractionError, type ReceiptExtractor } from '../src/extraction/extractor.js';
import { compileReviewGraph } from '../src/graph/graph.js';
import { silentLogger } from '../src/logger.js';
import { ReviewService } from '../src/review-service.js';
import { type ClaimStore, InMemoryClaimStore } from '../src/store/claim-store.js';
import { lunch } from './fixtures.js';

/** Test double: receipt texts are keys into a table of pre-extracted receipts. */
export class TableExtractor implements ReceiptExtractor {
  readonly calls: string[] = [];
  constructor(private readonly table: Record<string, Receipt>) {}

  async extract(receiptText: string): Promise<Receipt> {
    this.calls.push(receiptText);
    const receipt = this.table[receiptText];
    if (!receipt) throw new ExtractionError('no total or date found on the receipt');
    return receipt;
  }
}

export const RECEIPTS: Record<string, Receipt> = {
  'routine lunch': lunch(),
  'big dinner': lunch({ merchant: 'Restaurant zum Musterhof', total: 380, attendees: 2 }),
  'future taxi': lunch({
    merchant: 'Isar Taxi',
    category: 'ground_transport',
    attendees: 1,
    total: 32,
    date: '2026-11-30',
  }),
  'weekend lunch': lunch({ date: '2026-10-18' }),
};

export const SUBMITTED_AT = new Date('2026-10-22T09:00:00Z');

export function createService(
  options: {
    store?: ClaimStore;
    checkpointer?: BaseCheckpointSaver;
    extractor?: ReceiptExtractor;
    idPrefix?: string;
  } = {},
) {
  const store = options.store ?? new InMemoryClaimStore();
  const extractor = options.extractor ?? new TableExtractor(RECEIPTS);
  let n = 0;
  const graph = compileReviewGraph(
    { extractor, store, logger: silentLogger, now: () => SUBMITTED_AT },
    options.checkpointer ?? new MemorySaver(),
  );
  const service = new ReviewService(graph, store, {
    now: () => SUBMITTED_AT,
    newId: () => `${options.idPrefix ?? 'claim'}-${++n}`,
  });
  return { service, store, extractor };
}

export const claim = (receiptText: string, businessPurpose = 'Customer workshop follow-up with ACME') => ({
  employeeId: 'emp-42',
  receiptText,
  businessPurpose,
});
