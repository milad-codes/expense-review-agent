import { FakeListChatModel } from '@langchain/core/utils/testing';
import type { LLMResult } from '@langchain/core/outputs';
import { Budget, costUsd, UsageMeter, worstCaseCall } from '../src/eval/budget.js';
import { LlmReceiptExtractor } from '../src/extraction/llm-extractor.js';

const prices = { inputUsdPerMTok: 2, outputUsdPerMTok: 8 };

const resultWith = (usage: unknown): LLMResult => ({
  generations: [[{ text: '', message: { usage_metadata: usage } } as never]],
});

describe('costUsd', () => {
  it('prices input and output tokens per million', () => {
    expect(costUsd({ inputTokens: 1_000_000, outputTokens: 500_000 }, prices)).toBe(6);
  });
});

describe('UsageMeter', () => {
  it('adds the token usage that chat models report', () => {
    const meter = new UsageMeter();
    meter.handleLLMEnd(resultWith({ input_tokens: 900, output_tokens: 120 }));
    meter.handleLLMEnd(resultWith({ input_tokens: 100, output_tokens: 30 }));
    expect(meter).toMatchObject({ calls: 2, inputTokens: 1000, outputTokens: 150, unreported: 0 });
  });

  it('reads the older tokenUsage field and counts calls without any usage', () => {
    const meter = new UsageMeter();
    meter.handleLLMEnd({
      generations: [],
      llmOutput: { tokenUsage: { promptTokens: 10, completionTokens: 2 } },
    });
    meter.handleLLMEnd(resultWith(undefined));
    expect(meter).toMatchObject({ calls: 2, inputTokens: 10, outputTokens: 2, unreported: 1 });
  });

  it('sees every model call the extractor makes when attached to the model, including retries', async () => {
    const meter = new UsageMeter();
    const model = new FakeListChatModel({ responses: ['not json', 'still not json'], callbacks: [meter] });
    const extractor = new LlmReceiptExtractor(model, { method: 'jsonMode', maxAttempts: 2 });
    await expect(extractor.extract('SUMME 12,00')).rejects.toThrow();
    expect(meter.calls).toBe(2);
    // the fake model reports no usage, which a budgeted run treats as a reason to stop
    expect(meter.unreported).toBe(2);
  });
});

describe('Budget', () => {
  it('allows the next step only while its worst case fits into the limit', () => {
    const meter = new UsageMeter();
    const next = worstCaseCall(2_000, 1_024); // 1_667 tokens in, 1_024 out: $0.011526 at these prices
    expect(next).toEqual({ inputTokens: 1_667, outputTokens: 1_024 });
    expect(new Budget(0.02, prices, meter).canAfford(next)).toBe(true);
    expect(new Budget(0.01, prices, meter).canAfford(next)).toBe(false);
    meter.handleLLMEnd(resultWith({ input_tokens: 5_000, output_tokens: 0 })); // $0.01 spent
    expect(new Budget(0.02, prices, meter).canAfford(next)).toBe(false);
  });

  it('refuses to continue once a call reported no usage', () => {
    const meter = new UsageMeter();
    meter.handleLLMEnd(resultWith(undefined));
    expect(new Budget(100, prices, meter).canAfford({ inputTokens: 1, outputTokens: 1 })).toBe(false);
  });
});
