import { timingSafeEqual } from 'node:crypto';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import { ZodError } from 'zod';
import {
  ClaimNotFoundError,
  type ClaimView,
  NotAwaitingReviewError,
  NotRetryableError,
  ProcessingError,
  type ReviewService,
} from '../review-service.js';

export interface AppOptions {
  service: ReviewService;
  reviewToken: string;
  logger?: FastifyBaseLogger;
}

interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  errors?: string[];
  requestId?: string;
  claimId?: string;
}

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

const problem = (status: number, title: string, extra: Partial<Problem> = {}): Problem => ({
  type: 'about:blank',
  title,
  status,
  ...extra,
});

const sameSecret = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

/** Reviewer-facing summary for the pending list. */
const summary = (c: ClaimView) => ({
  claimId: c.claimId,
  employeeId: c.employeeId,
  submittedAt: c.submittedAt,
  merchant: c.receipt?.merchant ?? null,
  amountEur: c.evaluation?.amountEur ?? null,
  findings: c.evaluation?.findings.map((f) => f.code) ?? [],
});

export function buildApp(options: AppOptions): FastifyInstance {
  const app = Fastify({
    ...(options.logger ? { loggerInstance: options.logger } : { logger: false }),
    requestIdHeader: 'x-request-id',
    genReqId: () => crypto.randomUUID(),
    bodyLimit: 64 * 1024,
  });

  app.addHook('onRequest', async (request, reply) => {
    const incoming = request.headers['x-request-id'];
    if (typeof incoming === 'string' && !REQUEST_ID.test(incoming)) request.id = crypto.randomUUID();
    reply.header('x-request-id', request.id);
  });

  const requireReviewer = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!sameSecret(request.headers.authorization ?? '', `Bearer ${options.reviewToken}`)) {
      return reply
        .code(401)
        .type('application/problem+json')
        .send(problem(401, 'Unauthorized', { detail: 'Reviewer token required', requestId: request.id }));
    }
  };

  app.setErrorHandler((error, request, reply) => {
    let body: Problem;
    if (error instanceof ZodError) {
      body = problem(400, 'Bad request', {
        errors: error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`),
      });
    } else if (error instanceof ClaimNotFoundError) {
      body = problem(404, 'Not found', { detail: error.message });
    } else if (error instanceof NotAwaitingReviewError || error instanceof NotRetryableError) {
      body = problem(409, 'Conflict', { detail: error.message });
    } else if (error instanceof ProcessingError) {
      request.log.warn({ err: error, claimId: error.claimId }, 'claim processing failed');
      reply.header('retry-after', '30');
      body = problem(503, 'Service unavailable', {
        detail: `The claim was saved but could not be processed yet. Retry with POST /claims/${error.claimId}/retry.`,
        claimId: error.claimId,
      });
    } else if (
      (error as { statusCode?: number }).statusCode &&
      (error as { statusCode: number }).statusCode < 500
    ) {
      const status = (error as { statusCode: number }).statusCode;
      body = problem(status, 'Bad request', { detail: (error as Error).message });
    } else {
      request.log.error({ err: error }, 'unhandled error');
      body = problem(500, 'Internal server error');
    }
    return reply
      .code(body.status)
      .type('application/problem+json')
      .send({ ...body, requestId: request.id });
  });

  app.get('/health', async () => ({ status: 'ok' }));

  app.post('/claims', async (request, reply) => {
    const view = await options.service.submit(request.body as never);
    return reply.code(201).send(view);
  });

  app.get<{ Params: { id: string } }>('/claims/:id', async (request) => {
    const view = await options.service.get(request.params.id);
    if (!view) throw new ClaimNotFoundError(`Claim ${request.params.id} not found`);
    return view;
  });

  app.post<{ Params: { id: string } }>('/claims/:id/retry', async (request) =>
    options.service.retry(request.params.id),
  );

  app.get('/reviews/pending', { preHandler: requireReviewer }, async () =>
    (await options.service.pending()).map(summary),
  );

  app.post<{ Params: { id: string } }>(
    '/claims/:id/review',
    { preHandler: requireReviewer },
    async (request) => options.service.decide(request.params.id, request.body),
  );

  return app;
}
