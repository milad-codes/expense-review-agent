import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/http/app.js';
import { claim, createService } from './support.js';

const TOKEN = 'reviewer-token-for-tests';
const asReviewer = { authorization: `Bearer ${TOKEN}` };

describe('HTTP API', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = buildApp({ service: createService().service, reviewToken: TOKEN });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  const submit = (receiptText: string) =>
    app.inject({ method: 'POST', url: '/claims', payload: claim(receiptText) });

  it('submits and returns an auto-approved claim', async () => {
    const res = await submit('routine lunch');
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ status: 'approved', outcome: { reimbursableEur: 48.6 } });
    const fetched = await app.inject({ method: 'GET', url: `/claims/${res.json().claimId}` });
    expect(fetched.json().status).toBe('approved');
  });

  it('validates input with problem+json', async () => {
    const res = await app.inject({ method: 'POST', url: '/claims', payload: { receiptText: '' } });
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json().errors.join()).toMatch(/employeeId/);
  });

  it('returns 404 for unknown claims', async () => {
    const res = await app.inject({ method: 'GET', url: '/claims/unknown' });
    expect(res.statusCode).toBe(404);
  });

  it('protects reviewer endpoints', async () => {
    expect((await app.inject({ method: 'GET', url: '/reviews/pending' })).statusCode).toBe(401);
    const wrong = await app.inject({
      method: 'GET',
      url: '/reviews/pending',
      headers: { authorization: 'Bearer nope' },
    });
    expect(wrong.statusCode).toBe(401);
  });

  it('runs the review loop over HTTP', async () => {
    const { claimId } = (await submit('big dinner')).json();
    const pending = await app.inject({ method: 'GET', url: '/reviews/pending', headers: asReviewer });
    expect(pending.json()).toEqual([
      expect.objectContaining({
        claimId,
        merchant: 'Tantris',
        findings: ['OVER_LIMIT', 'ABOVE_AUTO_APPROVAL_LIMIT'],
      }),
    ]);

    const invalid = await app.inject({
      method: 'POST',
      url: `/claims/${claimId}/review`,
      headers: asReviewer,
      payload: { decision: 'ok' },
    });
    expect(invalid.statusCode).toBe(400);

    const decided = await app.inject({
      method: 'POST',
      url: `/claims/${claimId}/review`,
      headers: asReviewer,
      payload: { decision: 'approve', reviewer: 'Lena', comment: 'Client dinner' },
    });
    expect(decided.statusCode).toBe(200);
    expect(decided.json()).toMatchObject({
      status: 'approved',
      outcome: { decidedBy: { reviewer: 'Lena' } },
    });

    const again = await app.inject({
      method: 'POST',
      url: `/claims/${claimId}/review`,
      headers: asReviewer,
      payload: { decision: 'reject', reviewer: 'Max' },
    });
    expect(again.statusCode).toBe(409);
  });

  it('echoes safe request ids and replaces unsafe ones', async () => {
    const safe = await app.inject({ method: 'GET', url: '/health', headers: { 'x-request-id': 'trace-1' } });
    expect(safe.headers['x-request-id']).toBe('trace-1');
    const unsafe = await app.inject({ method: 'GET', url: '/health', headers: { 'x-request-id': 'a b' } });
    expect(unsafe.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('HTTP API with an unavailable provider', () => {
  it('answers 503 with the claim id, then succeeds on retry', async () => {
    let down = true;
    const extractor = {
      async extract() {
        if (down) throw new Error('provider unavailable');
        return (await import('./fixtures.js')).lunch();
      },
    };
    const app = buildApp({ service: createService({ extractor }).service, reviewToken: TOKEN });
    const res = await app.inject({ method: 'POST', url: '/claims', payload: claim('routine lunch') });
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('30');
    const { claimId } = res.json();
    down = false;
    const retried = await app.inject({ method: 'POST', url: `/claims/${claimId}/retry` });
    expect(retried.statusCode).toBe(200);
    expect(retried.json().status).toBe('approved');
    expect((await app.inject({ method: 'POST', url: `/claims/${claimId}/retry` })).statusCode).toBe(409);
    await app.close();
  });
});
