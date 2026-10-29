import { END, interrupt, START, StateGraph } from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph';
import { ExtractionError, type ReceiptExtractor } from '../extraction/extractor.js';
import type { Logger } from '../logger.js';
import { claimFingerprint } from '../policy/fingerprint.js';
import { DEFAULT_POLICY, evaluateClaim, type Evaluation, type PolicyConfig } from '../policy/policy.js';
import type { ClaimStore } from '../store/claim-store.js';
import {
  type AuditEvent,
  ClaimState,
  type ClaimStateType,
  type ClaimStateUpdate,
  type Outcome,
  type ReviewDecision,
  ReviewDecisionSchema,
  type ReviewRequest,
} from './state.js';

export interface GraphDeps {
  extractor: ReceiptExtractor;
  store: ClaimStore;
  logger: Logger;
  now?: () => Date;
  policy?: PolicyConfig;
}

export const NODES = {
  extract: 'extract',
  unreadable: 'mark_unreadable',
  evaluate: 'evaluate',
  review: 'human_review',
  finalize: 'finalize',
} as const;

type Node = (state: ClaimStateType) => Promise<ClaimStateUpdate> | ClaimStateUpdate;

/**
 * extract ──► evaluate ──┬─► finalize ──► END       (auto approve / auto reject)
 *    │                   └─► human_review ──► finalize
 *    └──► mark_unreadable ──► human_review          (the model could not read the receipt)
 */
export function buildReviewGraph(deps: GraphDeps) {
  const now = deps.now ?? (() => new Date());
  const policy = deps.policy ?? DEFAULT_POLICY;
  const event = (step: string, message: string): AuditEvent => ({ at: now().toISOString(), step, message });

  /** Logs duration and failures per node; the node's own behaviour is unchanged. */
  const traced =
    (name: string, node: Node): Node =>
    async (state) => {
      const started = performance.now();
      try {
        const update = await node(state);
        deps.logger.debug(
          { claimId: state.claimId, node: name, ms: Math.round(performance.now() - started) },
          'node completed',
        );
        return update;
      } catch (error) {
        // interrupts are control flow, not failures
        if ((error as Error)?.name !== 'GraphInterrupt') {
          deps.logger.error({ claimId: state.claimId, node: name, err: error }, 'node failed');
        }
        throw error;
      }
    };

  const extract: Node = async (state) => {
    try {
      const receipt = await deps.extractor.extract(state.receiptText);
      return {
        receipt,
        events: [
          event(
            NODES.extract,
            `Read ${receipt.category} receipt from ${receipt.merchant} (${receipt.total} ${receipt.currency}).`,
          ),
        ],
      };
    } catch (error) {
      if (!(error instanceof ExtractionError)) throw error;
      return {
        extractionError: error.message,
        events: [event(NODES.extract, `Receipt could not be read: ${error.message}`)],
      };
    }
  };

  const markUnreadable: Node = async (state) => {
    const evaluation: Evaluation = {
      amountEur: null,
      reimbursableEur: null,
      findings: [
        {
          code: 'EXTRACTION_FAILED',
          severity: 'review',
          message: 'The receipt could not be read automatically.',
        },
      ],
      route: 'human_review',
    };
    await deps.store.save({
      claimId: state.claimId,
      employeeId: state.employeeId,
      fingerprint: `unreadable:${state.claimId}`,
      status: 'pending',
      updatedAt: now().toISOString(),
    });
    return {
      evaluation,
      events: [event(NODES.unreadable, 'Sent to a reviewer because the receipt is unreadable.')],
    };
  };

  const evaluate: Node = async (state) => {
    const receipt = state.receipt;
    if (!receipt) throw new Error('evaluate reached without a receipt');
    const fingerprint = claimFingerprint(state.employeeId, receipt);
    const duplicateOf = await deps.store.findDuplicate(fingerprint, state.claimId);
    const evaluation = evaluateClaim(
      receipt,
      { submittedAt: new Date(state.submittedAt), businessPurpose: state.businessPurpose, duplicateOf },
      policy,
    );
    // recorded as pending right away, so a duplicate submitted while this one waits for review is caught
    await deps.store.save({
      claimId: state.claimId,
      employeeId: state.employeeId,
      fingerprint,
      status: 'pending',
      updatedAt: now().toISOString(),
    });
    const summary = evaluation.findings.map((f) => f.code).join(', ') || 'no findings';
    return { evaluation, events: [event(NODES.evaluate, `Policy route ${evaluation.route} (${summary}).`)] };
  };

  // Re-executed from the top when resumed, so nothing before interrupt() may have side effects.
  const humanReview: Node = (state) => {
    const evaluation = state.evaluation;
    if (!evaluation) throw new Error('human_review reached without an evaluation');
    const request: ReviewRequest = {
      claimId: state.claimId,
      employeeId: state.employeeId,
      businessPurpose: state.businessPurpose,
      receipt: state.receipt,
      evaluation,
      question: 'Approve or reject this expense claim?',
    };
    const decision = interrupt<ReviewRequest, ReviewDecision>(request, {
      responseSchema: ReviewDecisionSchema,
    });
    const comment = decision.comment ? `: ${decision.comment}` : '';
    return {
      review: { ...decision, decidedAt: now().toISOString() },
      events: [event(NODES.review, `${decision.reviewer} chose ${decision.decision}${comment}`)],
    };
  };

  const finalize: Node = async (state) => {
    const evaluation = state.evaluation;
    if (!evaluation) throw new Error('finalize reached without an evaluation');
    const decidedAt = now().toISOString();
    let outcome: Outcome;
    if (state.review) {
      const approved = state.review.decision === 'approve';
      outcome = {
        status: approved ? 'approved' : 'rejected',
        reimbursableEur: approved ? evaluation.reimbursableEur : 0,
        decidedBy: { reviewer: state.review.reviewer },
        reasons: [
          ...evaluation.findings.map((f) => f.message),
          ...(state.review.comment ? [`Reviewer: ${state.review.comment}`] : []),
        ],
        decidedAt,
      };
    } else {
      const approved = evaluation.route === 'auto_approve';
      outcome = {
        status: approved ? 'approved' : 'rejected',
        reimbursableEur: approved ? evaluation.reimbursableEur : 0,
        decidedBy: 'policy',
        reasons: evaluation.findings.filter((f) => approved || f.severity === 'block').map((f) => f.message),
        decidedAt,
      };
    }
    const existing = await deps.store.get(state.claimId);
    await deps.store.save({
      claimId: state.claimId,
      employeeId: state.employeeId,
      fingerprint: existing?.fingerprint ?? `unknown:${state.claimId}`,
      status: outcome.status,
      updatedAt: decidedAt,
    });
    return { outcome, events: [event(NODES.finalize, `Claim ${outcome.status}.`)] };
  };

  return new StateGraph(ClaimState)
    .addNode(NODES.extract, traced(NODES.extract, extract))
    .addNode(NODES.unreadable, traced(NODES.unreadable, markUnreadable))
    .addNode(NODES.evaluate, traced(NODES.evaluate, evaluate))
    .addNode(NODES.review, traced(NODES.review, humanReview))
    .addNode(NODES.finalize, traced(NODES.finalize, finalize))
    .addEdge(START, NODES.extract)
    .addConditionalEdges(NODES.extract, (s) => (s.extractionError ? NODES.unreadable : NODES.evaluate), [
      NODES.unreadable,
      NODES.evaluate,
    ])
    .addEdge(NODES.unreadable, NODES.review)
    .addConditionalEdges(
      NODES.evaluate,
      (s) => (s.evaluation?.route === 'human_review' ? NODES.review : NODES.finalize),
      [NODES.review, NODES.finalize],
    )
    .addEdge(NODES.review, NODES.finalize)
    .addEdge(NODES.finalize, END);
}

export function compileReviewGraph(deps: GraphDeps, checkpointer: BaseCheckpointSaver) {
  return buildReviewGraph(deps).compile({ checkpointer });
}

export type ReviewGraph = ReturnType<typeof compileReviewGraph>;
