import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { pino } from 'pino';
import { loadEnv } from './config.js';
import { LlmReceiptExtractor } from './extraction/llm-extractor.js';
import { createChatModel } from './extraction/models.js';
import { compileReviewGraph } from './graph/graph.js';
import { buildApp } from './http/app.js';
import { ReviewService } from './review-service.js';
import { SqliteClaimStore } from './store/sqlite-claim-store.js';

const env = loadEnv();
const logger = pino({
  level: env.LOG_LEVEL,
  redact: { paths: ['req.headers.authorization', 'receiptText'], censor: '[Redacted]' },
});

mkdirSync(env.DATA_DIR, { recursive: true });
const store = new SqliteClaimStore(join(env.DATA_DIR, 'claims.sqlite'));
const checkpointer = SqliteSaver.fromConnString(join(env.DATA_DIR, 'checkpoints.sqlite'));
const extractor = new LlmReceiptExtractor(createChatModel(env), {
  maxAttempts: env.EXTRACTION_MAX_ATTEMPTS,
  logger,
});
const graph = compileReviewGraph({ extractor, store, logger }, checkpointer);
const app = buildApp({ service: new ReviewService(graph, store), reviewToken: env.REVIEW_API_TOKEN, logger });

const shutdown = async (signal: string) => {
  logger.info({ signal }, 'shutting down');
  await app.close();
  store.close();
  process.exit(0);
};
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: env.PORT, host: '0.0.0.0' });
logger.info(
  { port: env.PORT, provider: env.LLM_PROVIDER, model: env.LLM_MODEL },
  'expense-review-agent listening',
);
