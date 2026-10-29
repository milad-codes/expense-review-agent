import { z } from 'zod';

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    DATA_DIR: z.string().default('./data'),
    LLM_PROVIDER: z.enum(['openai', 'anthropic']),
    /** Provider model id, e.g. a current OpenAI or Anthropic model name. No default: pin it explicitly. */
    LLM_MODEL: z.string().min(1),
    /** Bearer token for the reviewer endpoints. */
    REVIEW_API_TOKEN: z.string().min(16, 'use at least 16 characters'),
    EXTRACTION_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(2),
  })
  .loose();

export type Env = z.infer<typeof EnvSchema>;

/** The subset the LLM evaluation needs: it runs no HTTP server, so no reviewer token or port. */
const LlmEnvSchema = EnvSchema.pick({ LLM_PROVIDER: true, LLM_MODEL: true, EXTRACTION_MAX_ATTEMPTS: true });
export type LlmEnv = z.infer<typeof LlmEnvSchema>;

function parseEnv<T>(schema: z.ZodType<T>, raw: Record<string, string | undefined>): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  return parsed.data;
}

/** Fails fast with every invalid variable listed. */
export function loadEnv(raw: Record<string, string | undefined> = process.env): Env {
  return parseEnv(EnvSchema, raw);
}

export function loadLlmEnv(raw: Record<string, string | undefined> = process.env): LlmEnv {
  return parseEnv(LlmEnvSchema, raw);
}
