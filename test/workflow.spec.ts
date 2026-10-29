import { ZodError } from 'zod';
import { ClaimNotFoundError, NotAwaitingReviewError } from '../src/review-service.js';
import { claim, createService } from './support.js';

const approve = {
  decision: 'approve',
  reviewer: 'Lena (Finance)',
  comment: 'Client dinner, agreed in advance.',
};

describe('review workflow', () => {
  it('auto-approves a routine claim without a human', async () => {
    const { service, store } = createService();
    const view = await service.submit(claim('routine lunch'));
    expect(view).toMatchObject({ status: 'approved', reviewRequest: null });
    expect(view.outcome).toMatchObject({ status: 'approved', reimbursableEur: 48.6, decidedBy: 'policy' });
    expect(view.events.map((e) => e.step)).toEqual(['extract', 'evaluate', 'finalize']);
    expect((await store.get(view.claimId))?.status).toBe('approved');
  });

  it('auto-rejects a blocking violation and says why', async () => {
    const { service } = createService();
    const view = await service.submit(claim('future taxi'));
    expect(view.status).toBe('rejected');
    expect(view.outcome?.reimbursableEur).toBe(0);
    expect(view.outcome?.reasons.join()).toMatch(/after the submission date/);
  });

  it('rejects a duplicate of an earlier claim', async () => {
    const { service } = createService();
    const first = await service.submit(claim('routine lunch'));
    const second = await service.submit(claim('routine lunch'));
    expect(second.status).toBe('rejected');
    expect(second.evaluation?.findings[0]).toMatchObject({
      code: 'DUPLICATE',
      message: expect.stringContaining(first.claimId),
    });
  });

  describe('human in the loop', () => {
    it('pauses for review with everything a reviewer needs', async () => {
      const { service } = createService();
      const view = await service.submit(claim('big dinner'));
      expect(view.status).toBe('needs_review');
      expect(view.outcome).toBeNull();
      expect(view.reviewRequest).toMatchObject({
        claimId: view.claimId,
        receipt: { merchant: 'Tantris' },
        evaluation: {
          route: 'human_review',
          findings: [expect.objectContaining({ code: 'OVER_LIMIT' }), expect.anything()],
        },
      });
      expect((await service.pending()).map((c) => c.claimId)).toEqual([view.claimId]);
    });

    it('applies an approval and records who decided', async () => {
      const { service, store } = createService();
      const { claimId } = await service.submit(claim('big dinner'));
      const view = await service.decide(claimId, approve);
      expect(view.status).toBe('approved');
      expect(view.outcome).toMatchObject({ decidedBy: { reviewer: 'Lena (Finance)' }, reimbursableEur: 380 });
      expect(view.outcome?.reasons).toContain('Reviewer: Client dinner, agreed in advance.');
      expect(view.events.at(-2)?.message).toMatch(/Lena \(Finance\) chose approve/);
      expect(await service.pending()).toEqual([]);
      expect((await store.get(claimId))?.status).toBe('approved');
    });

    it('applies a rejection', async () => {
      const { service } = createService();
      const { claimId } = await service.submit(claim('weekend lunch'));
      const view = await service.decide(claimId, { decision: 'reject', reviewer: 'Lena' });
      expect(view.outcome).toMatchObject({ status: 'rejected', reimbursableEur: 0 });
    });

    it('rejects invalid decisions and keeps the claim waiting', async () => {
      const { service } = createService();
      const { claimId } = await service.submit(claim('big dinner'));
      await expect(service.decide(claimId, { decision: 'maybe', reviewer: 'Lena' })).rejects.toBeInstanceOf(
        ZodError,
      );
      await expect(service.decide(claimId, { decision: 'approve', reviewer: ' ' })).rejects.toBeInstanceOf(
        ZodError,
      );
      expect((await service.get(claimId))?.status).toBe('needs_review');
    });

    it('refuses a second decision', async () => {
      const { service } = createService();
      const { claimId } = await service.submit(claim('big dinner'));
      await service.decide(claimId, approve);
      await expect(service.decide(claimId, approve)).rejects.toBeInstanceOf(NotAwaitingReviewError);
    });

    it('lets only one of two concurrent decisions through', async () => {
      const { service } = createService();
      const { claimId } = await service.submit(claim('big dinner'));
      const results = await Promise.allSettled([
        service.decide(claimId, approve),
        service.decide(claimId, { decision: 'reject', reviewer: 'Max' }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
      const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(rejected.reason).toBeInstanceOf(NotAwaitingReviewError);
    });
  });

  it('sends unreadable receipts to a human instead of guessing', async () => {
    const { service } = createService();
    const view = await service.submit(claim('coffee stain, no text'));
    expect(view.status).toBe('needs_review');
    expect(view.receipt).toBeNull();
    expect(view.evaluation?.findings).toEqual([expect.objectContaining({ code: 'EXTRACTION_FAILED' })]);
    const decided = await service.decide(view.claimId, {
      decision: 'reject',
      reviewer: 'Lena',
      comment: 'Please upload a readable receipt.',
    });
    expect(decided.status).toBe('rejected');
  });

  it('reports unknown claims', async () => {
    const { service } = createService();
    expect(await service.get('nope')).toBeNull();
    await expect(service.decide('nope', approve)).rejects.toBeInstanceOf(ClaimNotFoundError);
  });

  it('validates submissions', async () => {
    const { service } = createService();
    await expect(service.submit({ employeeId: '', receiptText: 'x' })).rejects.toBeInstanceOf(ZodError);
  });
});

describe('provider failures', () => {
  it('keeps the claim and resumes from the failed step on retry', async () => {
    const { ProcessingError } = await import('../src/review-service.js');
    let calls = 0;
    const flaky = {
      async extract() {
        calls += 1;
        if (calls === 1) throw new Error('connect ECONNREFUSED api.example.com');
        return (await import('./fixtures.js')).lunch();
      },
    };
    const { service } = createService({ extractor: flaky });
    const failure = await service.submit(claim('routine lunch')).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ProcessingError);
    const claimId = (failure as InstanceType<typeof ProcessingError>).claimId;
    expect(await service.get(claimId)).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/ECONNREFUSED/),
    });

    const view = await service.retry(claimId);
    expect(view.status).toBe('approved');
    expect(calls).toBe(2);
  });
});
