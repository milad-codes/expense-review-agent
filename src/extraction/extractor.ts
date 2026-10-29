import type { Receipt } from '../domain/receipt.js';

/** Thrown when a receipt cannot be turned into a valid `Receipt` (unreadable text, invalid model output). */
export class ExtractionError extends Error {
  override readonly name = 'ExtractionError';
}

/** Turns free-form receipt text into structured data. Implementations must not apply policy. */
export interface ReceiptExtractor {
  extract(receiptText: string): Promise<Receipt>;
}
