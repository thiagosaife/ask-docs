/**
 * USD per 1M tokens. Anthropic prices from the Claude API reference (2026-06);
 * OpenAI prices from openai.com/api/pricing. Override with PRICING_JSON env if they drift.
 */
export interface Price {
  input: number;
  output: number;
  cacheRead?: number;
}

const DEFAULT_PRICES: Record<string, Price> = {
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1 },
  'gpt-5-mini': { input: 0.25, output: 2 },
  'gpt-5': { input: 1.25, output: 10 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'text-embedding-3-small': { input: 0.02, output: 0 },
  'text-embedding-3-large': { input: 0.13, output: 0 },
};

const prices: Record<string, Price> = {
  ...DEFAULT_PRICES,
  ...(process.env.PRICING_JSON ? (JSON.parse(process.env.PRICING_JSON) as Record<string, Price>) : {}),
};

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
}

export function costUsd(model: string, usage: TokenUsage): number {
  const p = prices[model];
  if (!p) return 0;
  const cached = usage.cacheReadTokens ?? 0;
  const uncached = Math.max(0, usage.inputTokens - cached);
  const cost =
    (uncached * p.input + cached * (p.cacheRead ?? p.input) + usage.outputTokens * p.output) / 1_000_000;
  return Math.round(cost * 1e6) / 1e6;
}

export function hasPrice(model: string): boolean {
  return model in prices;
}
