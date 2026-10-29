import { ChatAnthropic } from '@langchain/anthropic';
import type { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatOpenAI } from '@langchain/openai';
import type { Env } from '../config.js';

/** An extraction answer is a few hundred tokens; the cap bounds the cost of a model that rambles. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 1024;

export interface ModelOptions {
  maxTokens?: number;
  /**
   * Handlers attached to the model itself, so they see every call: callbacks passed to `invoke` on a
   * `withStructuredOutput` runnable do not always reach the chat model inside it.
   */
  callbacks?: BaseCallbackHandler[];
}

/** API keys are read by the provider SDKs from OPENAI_API_KEY / ANTHROPIC_API_KEY. */
export function createChatModel(
  env: Pick<Env, 'LLM_PROVIDER' | 'LLM_MODEL'>,
  { maxTokens = DEFAULT_MAX_OUTPUT_TOKENS, callbacks }: ModelOptions = {},
): BaseChatModel {
  switch (env.LLM_PROVIDER) {
    case 'openai':
      return new ChatOpenAI({
        model: env.LLM_MODEL,
        temperature: 0,
        maxRetries: 2,
        timeout: 30_000,
        maxTokens,
        callbacks,
      });
    case 'anthropic':
      return new ChatAnthropic({ model: env.LLM_MODEL, temperature: 0, maxRetries: 2, maxTokens, callbacks });
  }
}
