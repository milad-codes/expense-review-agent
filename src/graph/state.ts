import { ReducedValue, StateSchema } from '@langchain/langgraph';
import { z } from 'zod';
import { type Receipt, ReceiptSchema } from '../domain/receipt.js';
import type { Evaluation } from '../policy/policy.js';

/** What a reviewer sends to resume a paused claim. Also used as the interrupt's response schema. */
export const ReviewDecisionSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  reviewer: z.string().trim().min(1).max(100),
  comment: z.string().trim().max(2000).default(''),
});
export type ReviewDecision = z.infer<typeof ReviewDecisionSchema>;

export interface ReviewRecord extends ReviewDecision {
  decidedAt: string;
}

export interface Outcome {
  status: 'approved' | 'rejected';
  /** Amount to pay out in EUR; null when it could not be determined automatically. */
  reimbursableEur: number | null;
  decidedBy: 'policy' | { reviewer: string };
  reasons: string[];
  decidedAt: string;
}

export const AuditEventSchema = z.object({ at: z.string(), step: z.string(), message: z.string() });
export type AuditEvent = z.infer<typeof AuditEventSchema>;

/** Payload shown to the reviewer while a claim waits in `human_review`. */
export interface ReviewRequest {
  claimId: string;
  employeeId: string;
  businessPurpose: string;
  receipt: Receipt | null;
  evaluation: Evaluation;
  question: string;
}

export const ClaimState = new StateSchema({
  claimId: z.string(),
  employeeId: z.string(),
  receiptText: z.string(),
  businessPurpose: z.string(),
  submittedAt: z.string(),
  receipt: ReceiptSchema.nullable().default(null),
  extractionError: z.string().nullable().default(null),
  evaluation: z.custom<Evaluation>().nullable().default(null),
  review: z.custom<ReviewRecord>().nullable().default(null),
  outcome: z.custom<Outcome>().nullable().default(null),
  /** Append-only audit trail; every node adds what it did. */
  events: new ReducedValue(
    z.array(AuditEventSchema).default(() => []),
    {
      inputSchema: z.array(AuditEventSchema),
      reducer: (current, next) => [...current, ...next],
    },
  ),
});

export type ClaimStateType = typeof ClaimState.State;
export type ClaimStateUpdate = typeof ClaimState.Update;
