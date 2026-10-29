import { ChatAnthropic } from '@langchain/anthropic';
import { ChatOpenAI } from '@langchain/openai';
import { UsageMeter } from '../src/eval/budget.js';
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

  it('caps output tokens and attaches callbacks to the model itself', () => {
    const meter = new UsageMeter();
    const openai = createChatModel(
      { LLM_PROVIDER: 'openai', LLM_MODEL: 'model-a' },
      { maxTokens: 300, callbacks: [meter] },
    );
    expect((openai as ChatOpenAI).maxTokens).toBe(300);
    expect(openai.callbacks).toEqual([meter]);
    const anthropic = createChatModel(
      { LLM_PROVIDER: 'anthropic', LLM_MODEL: 'model-b' },
      { callbacks: [meter] },
    );
    expect((anthropic as ChatAnthropic).maxTokens).toBe(1024);
    expect(anthropic.callbacks).toEqual([meter]);
  });
});
