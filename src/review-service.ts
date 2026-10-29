import { randomUUID } from 'node:crypto';
import { Command } from '@langchain/langgraph';
import { z } from 'zod';
import type { Receipt } from './domain/receipt.js';
import { NODES, type ReviewGraph } from './graph/graph.js';
import {
  type AuditEvent,
  type ClaimStateType,
  type Outcome,
  type ReviewDecision,
  ReviewDecisionSchema,
  type ReviewRecord,
  type ReviewRequest,
} from './graph/state.js';
import type { Evaluation } from './policy/policy.js';
import type { ClaimStore } from './store/claim-store.js';

export const ClaimInputSchema = z.object({
  employeeId: z.string().trim().min(1).max(100),
  receiptText: z.string().trim().min(1).max(20_000),
  businessPurpose: z.string().trim().max(1_000).default(''),
});
export type ClaimInput = z.input<typeof ClaimInputSchema>;

export type ClaimStatus = 'approved' | 'rejected' | 'needs_review' | 'processing';

export interface ClaimView {
  claimId: string;
  status: ClaimStatus;
  employeeId: string;
  businessPurpose: string;
  submittedAt: string;
  receipt: Receipt | null;
  evaluation: Evaluation | null;
  review: ReviewRecord | null;
  outcome: Outcome | null;
  reviewRequest: ReviewRequest | null;
  events: AuditEvent[];
}

export class ClaimNotFoundError extends Error {
  override readonly name = 'ClaimNotFoundError';
}
export class NotAwaitingReviewError extends Error {
  override readonly name = 'NotAwaitingReviewError';
}

/**
 * Application service around the review graph. Each claim is one LangGraph thread (thread_id = claimId), so its
 * whole history lives in the checkpointer and a paused review survives restarts.
 */
export class ReviewService {
  /** Serialises work per claim inside this process: two reviewers cannot resume the same thread twice. */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly graph: ReviewGraph,
    private readonly store: ClaimStore,
    private readonly options: { now?: () => Date; newId?: () => string } = {},
  ) {}

  async submit(input: ClaimInput): Promise<ClaimView> {
    const claim = ClaimInputSchema.parse(input);
    const claimId = (this.options.newId ?? randomUUID)();
    if (await this.get(claimId)) throw new Error(`Claim id ${claimId} already exists`);
    const submittedAt = (this.options.now?.() ?? new Date()).toISOString();
    await this.graph.invoke({ claimId, submittedAt, ...claim }, this.config(claimId));
    return this.getOrFail(claimId);
  }

  async get(claimId: string): Promise<ClaimView | null> {
    const snapshot = await this.graph.getState(this.config(claimId));
    const values = snapshot.values as Partial<ClaimStateType>;
    if (!values.claimId) return null;
    const waiting = snapshot.next.includes(NODES.review);
    const reviewRequest = waiting
      ? ((snapshot.tasks.flatMap((t) => t.interrupts)[0]?.value as ReviewRequest | undefined) ?? null)
      : null;
    return {
      claimId: values.claimId,
      status: values.outcome ? values.outcome.status : waiting ? 'needs_review' : 'processing',
      employeeId: values.employeeId ?? '',
      businessPurpose: values.businessPurpose ?? '',
      submittedAt: values.submittedAt ?? '',
      receipt: values.receipt ?? null,
      evaluation: values.evaluation ?? null,
      review: values.review ?? null,
      outcome: values.outcome ?? null,
      reviewRequest,
      events: values.events ?? [],
    };
  }

  async pending(): Promise<ClaimView[]> {
    const records = await this.store.listByStatus('pending');
    const views = await Promise.all(records.map((r) => this.get(r.claimId)));
    return views.filter((v): v is ClaimView => v?.status === 'needs_review');
  }

  /** Resumes a claim waiting for review. Validates the decision before touching the graph. */
  async decide(claimId: string, decision: unknown): Promise<ClaimView> {
    const parsed: ReviewDecision = ReviewDecisionSchema.parse(decision);
    return this.withLock(claimId, async () => {
      const current = await this.get(claimId);
      if (!current) throw new ClaimNotFoundError(`Claim ${claimId} not found`);
      if (current.status !== 'needs_review') {
        throw new NotAwaitingReviewError(`Claim ${claimId} is ${current.status}, not awaiting review`);
      }
      await this.graph.invoke(new Command({ resume: parsed }), this.config(claimId));
      return this.getOrFail(claimId);
    });
  }

  private async getOrFail(claimId: string): Promise<ClaimView> {
    const view = await this.get(claimId);
    if (!view) throw new ClaimNotFoundError(`Claim ${claimId} not found`);
    return view;
  }

  private config(claimId: string) {
    return { configurable: { thread_id: claimId } };
  }

  private async withLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(work);
    this.locks.set(key, run);
    try {
      return await run;
    } finally {
      if (this.locks.get(key) === run) this.locks.delete(key);
    }
  }
}
