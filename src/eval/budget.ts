import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { LLMResult } from '@langchain/core/outputs';

/** Provider list prices in US dollars per million tokens. Taken from the command line, never guessed. */
export interface Prices {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
}

export interface TokenCount {
  inputTokens: number;
  outputTokens: number;
}

export const costUsd = (tokens: TokenCount, prices: Prices): number =>
  (tokens.inputTokens * prices.inputUsdPerMTok + tokens.outputTokens * prices.outputUsdPerMTok) / 1_000_000;

/**
 * Upper bound for one extraction call. Three characters per token over-estimates typical receipt text, and the
 * fixed allowance covers message framing and the structured-output schema sent with every request.
 */
export const worstCaseCall = (promptChars: number, maxOutputTokens: number): TokenCount => ({
  inputTokens: Math.ceil(promptChars / 3) + 1_000,
  outputTokens: maxOutputTokens,
});

interface UsageMetadata {
  input_tokens?: number;
  output_tokens?: number;
}

/** Counts every model call and the tokens the provider reports for it. */
export class UsageMeter extends BaseCallbackHandler {
  name = 'usage-meter';
  /** LangChain may run callbacks in the background; the budget check needs the count before the next call. */
  override awaitHandlers = true;
  calls = 0;
  inputTokens = 0;
  outputTokens = 0;
  /** Calls whose provider reported no usage. Their cost is unknown, so a budgeted run must stop. */
  unreported = 0;

  override handleLLMEnd(output: LLMResult): void {
    this.calls += 1;
    const generation = output.generations[0]?.[0] as
      { message?: { usage_metadata?: UsageMetadata } } | undefined;
    const usage = generation?.message?.usage_metadata;
    const legacy = output.llmOutput?.tokenUsage as
      { promptTokens?: number; completionTokens?: number } | undefined;
    const input = usage?.input_tokens ?? legacy?.promptTokens;
    const out = usage?.output_tokens ?? legacy?.completionTokens;
    if (input === undefined || out === undefined) {
      this.unreported += 1;
      return;
    }
    this.inputTokens += input;
    this.outputTokens += out;
  }
}

/** Stops an evaluation before its next step could push the spend over the limit. */
export class Budget {
  constructor(
    readonly maxUsd: number,
    readonly prices: Prices,
    readonly meter: UsageMeter,
  ) {}

  spentUsd(): number {
    return costUsd(this.meter, this.prices);
  }

  canAfford(next: TokenCount): boolean {
    return this.meter.unreported === 0 && this.spentUsd() + costUsd(next, this.prices) <= this.maxUsd;
  }
}
