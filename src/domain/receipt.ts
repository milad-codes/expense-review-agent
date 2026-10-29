import { z } from 'zod';

export const CATEGORIES = [
  'meal',
  'lodging',
  'ground_transport',
  'airfare',
  'office_supplies',
  'software',
  'other',
] as const;
export type Category = (typeof CATEGORIES)[number];

/**
 * What the extraction step must produce from a receipt. Every field is required (no defaults), which keeps the
 * JSON schema compatible with strict structured-output modes of LLM providers.
 */
export const ReceiptSchema = z.object({
  merchant: z.string().min(1).describe('Merchant or vendor name as printed on the receipt'),
  date: z.iso.date().describe('Transaction date as YYYY-MM-DD'),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .describe('ISO 4217 currency code of the total, e.g. EUR'),
  total: z.number().positive().describe('Total amount paid including tax, in `currency`'),
  category: z.enum(CATEGORIES).describe('Expense category'),
  attendees: z.number().int().min(1).describe('Number of people covered by a meal; 1 for other categories'),
  nights: z.number().int().min(0).describe('Number of nights for lodging; 0 for other categories'),
  alcoholAmount: z.number().min(0).describe('Sum of alcoholic line items in `currency`; 0 if there are none'),
});

export type Receipt = z.infer<typeof ReceiptSchema>;
