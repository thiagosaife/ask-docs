/**
 * The ONLY module that talks to model providers. Everything else calls these functions.
 *
 * - answer: Anthropic (claude-opus-5 by default), streamed.
 * - embed:  OpenAI text-embedding-3-small.
 * - judge:  OpenAI gpt-5-mini — deliberately a different model family than the answerer.
 */
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { embedMany, generateText, streamText, Output } from 'ai';
import type { z } from 'zod';
import { config } from './config.js';
import { costUsd, type TokenUsage } from './pricing.js';

const anthropic = createAnthropic({ apiKey: config.anthropicApiKey ?? 'missing' });
const openai = createOpenAI({ apiKey: config.openaiApiKey ?? 'missing' });

export function requireKeys(which: Array<'anthropic' | 'openai'>): void {
  for (const k of which) {
    if (k === 'anthropic' && !config.anthropicApiKey) throw new Error('ANTHROPIC_API_KEY is not set');
    if (k === 'openai' && !config.openaiApiKey) throw new Error('OPENAI_API_KEY is not set');
  }
}

export interface UsageReport extends TokenUsage {
  model: string;
  costUsd: number;
}

// ---------- embeddings ----------

export async function embedTexts(texts: string[], signal?: AbortSignal): Promise<{ vectors: number[][]; usage: UsageReport }> {
  requireKeys(['openai']);
  if (texts.length === 0) {
    return { vectors: [], usage: { model: config.models.embed, inputTokens: 0, outputTokens: 0, costUsd: 0 } };
  }
  const res = await embedMany({
    model: openai.textEmbedding(config.models.embed),
    values: texts,
    maxParallelCalls: 4,
    ...(signal ? { abortSignal: signal } : {}),
  });
  const inputTokens = res.usage.tokens;
  return {
    vectors: res.embeddings as number[][],
    usage: {
      model: config.models.embed,
      inputTokens,
      outputTokens: 0,
      costUsd: costUsd(config.models.embed, { inputTokens, outputTokens: 0 }),
    },
  };
}

// ---------- answer (streamed) ----------

export interface AnswerStreamOptions {
  system: string;
  user: string;
  signal?: AbortSignal;
  maxOutputTokens?: number;
}

export interface AnswerStreamResult {
  /** Text deltas as the provider emits them. */
  textStream: AsyncIterable<string>;
  /** Resolves after the stream ends (or is aborted) with usage + finish reason. */
  final: Promise<{ usage: UsageReport; finishReason: string; text: string }>;
}

export function streamAnswer(opts: AnswerStreamOptions): AnswerStreamResult {
  requireKeys(['anthropic']);
  const model = config.models.answer;
  const result = streamText({
    model: anthropic(model),
    system: opts.system,
    prompt: opts.user,
    maxOutputTokens: opts.maxOutputTokens ?? 1024,
    temperature: 0,
    ...(opts.signal ? { abortSignal: opts.signal } : {}),
    providerOptions: {
      anthropic: {
        // adaptive thinking at low effort: this is a grounded Q&A task, not a reasoning task
        thinking: { type: 'adaptive' },
        effort: 'low',
      },
    },
  });

  const final = (async () => {
    // These promises settle even on abort (usage may be partial/undefined).
    const [usage, finishReason, text] = await Promise.all([
      result.usage.then((u) => u, () => undefined),
      result.finishReason.then((f) => f, () => 'error' as const),
      result.text.then((t) => t, () => ''),
    ]);
    const inputTokens = usage?.inputTokens ?? 0;
    const outputTokens = usage?.outputTokens ?? 0;
    const cacheReadTokens = usage?.inputTokenDetails?.cacheReadTokens ?? 0;
    return {
      usage: {
        model,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        costUsd: costUsd(model, { inputTokens, outputTokens, cacheReadTokens }),
      },
      finishReason,
      text,
    };
  })();

  return { textStream: result.textStream, final };
}

// ---------- judge (structured, different family) ----------

export async function judgeObject<T>(opts: {
  system: string;
  user: string;
  schema: z.ZodType<T>;
  signal?: AbortSignal;
}): Promise<{ object: T; usage: UsageReport }> {
  requireKeys(['openai']);
  const model = config.models.judge;
  const res = await generateText({
    model: openai(model),
    system: opts.system,
    prompt: opts.user,
    output: Output.object({ schema: opts.schema }),
    ...(opts.signal ? { abortSignal: opts.signal } : {}),
    providerOptions: { openai: { reasoningEffort: 'low' } },
  });
  const inputTokens = res.usage.inputTokens ?? 0;
  const outputTokens = res.usage.outputTokens ?? 0;
  if (res.output === undefined) throw new Error('judge returned no structured output');
  return {
    object: res.output as T,
    usage: { model, inputTokens, outputTokens, costUsd: costUsd(model, { inputTokens, outputTokens }) },
  };
}
