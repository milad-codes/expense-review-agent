import { ChatAnthropic } from '@langchain/anthropic';
import { ChatOpenAI } from '@langchain/openai';
import { createChatModel } from '../src/extraction/models.js';

describe('createChatModel', () => {
  beforeAll(() => {
    process.env.OPENAI_API_KEY ??= 'test-key';
    process.env.ANTHROPIC_API_KEY ??= 'test-key';
  });

  it('builds the configured provider with deterministic sampling', () => {
    const openai = createChatModel({ LLM_PROVIDER: 'openai', LLM_MODEL: 'model-a' });
    expect(openai).toBeInstanceOf(ChatOpenAI);
    expect((openai as ChatOpenAI).temperature).toBe(0);
    expect(createChatModel({ LLM_PROVIDER: 'anthropic', LLM_MODEL: 'model-b' })).toBeInstanceOf(
      ChatAnthropic,
    );
  });
});
