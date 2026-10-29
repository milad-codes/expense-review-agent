import { ChatAnthropic } from '@langchain/anthropic';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatOpenAI } from '@langchain/openai';
import type { Env } from '../config.js';

/** API keys are read by the provider SDKs from OPENAI_API_KEY / ANTHROPIC_API_KEY. */
export function createChatModel(env: Pick<Env, 'LLM_PROVIDER' | 'LLM_MODEL'>): BaseChatModel {
  switch (env.LLM_PROVIDER) {
    case 'openai':
      return new ChatOpenAI({ model: env.LLM_MODEL, temperature: 0, maxRetries: 2, timeout: 30_000 });
    case 'anthropic':
      return new ChatAnthropic({ model: env.LLM_MODEL, temperature: 0, maxRetries: 2 });
  }
}
