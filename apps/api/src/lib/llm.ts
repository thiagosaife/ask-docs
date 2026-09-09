/**
 * The ONLY module that talks to model providers. Everything else calls these functions.
 *
 * Anthropic-first: the app runs with ANTHROPIC_API_KEY alone.
 * - answer: Anthropic (claude-opus-5 by default), streamed.
 * - embed:  local ONNX model via transformers.js by default (Xenova/bge-small-en-v1.5, no key);
 *           OpenAI text-embedding-* when EMBED_MODEL says so.
 * - judge:  gpt-5-mini when an OpenAI key exists (different family than the answerer),
 *           otherwise claude-sonnet-5 (different model, same family — recorded in eval_runs.judge_model).
 */
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { embedMany, generateText, smoothStream, streamText, Output } from 'ai';
import type { z } from 'zod';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, providerFor } from './config.js';
import { costUsd, type TokenUsage } from './pricing.js';
import { countTokens } from './tokens.js';

const anthropic = createAnthropic({ apiKey: config.anthropicApiKey ?? 'missing' });
const openai = createOpenAI({ apiKey: config.openaiApiKey ?? 'missing' });

export function requireKeys(which: Array<'anthropic' | 'openai' | 'local'>): void {
  for (const k of which) {
    if (k === 'anthropic' && !config.anthropicApiKey) throw new Error('ANTHROPIC_API_KEY is not set');
    if (k === 'openai' && !config.openaiApiKey) throw new Error('OPENAI_API_KEY is not set');
  }
}

/** Selects the chat-model instance for a model id (anthropic vs openai). */
function chatModel(model: string) {
  const p = providerFor(model);
  requireKeys([p]);
  return p === 'anthropic' ? anthropic(model) : openai(model);
}

export interface UsageReport extends TokenUsage {
  model: string;
  costUsd: number;
}

// ---------- embeddings ----------

const modelsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.models');

interface LocalEmbedder {
  embed(texts: string[]): Promise<number[][]>;
}

let localEmbedder: Promise<LocalEmbedder> | undefined;

/** Local sentence embeddings (transformers.js, int8 ONNX, cached under apps/api/.models). */
function getLocalEmbedder(model: string): Promise<LocalEmbedder> {
  localEmbedder ??= (async () => {
    const tf = await import('@huggingface/transformers');
    tf.env.cacheDir = modelsDir;
    let extractor: Awaited<ReturnType<typeof tf.pipeline<'feature-extraction'>>>;
    try {
      extractor = await tf.pipeline('feature-extraction', model, { dtype: 'q8' });
    } catch (e) {
      localEmbedder = undefined; // do not cache the failure; the next call retries the download
      throw new Error(`local embedding model ${model} failed to load (cache ${modelsDir}): ${(e as Error).message}`);
    }
    return {
      async embed(texts) {
        const out: number[][] = [];
        const batch = 16;
        for (let i = 0; i < texts.length; i += batch) {
          const slice = texts.slice(i, i + batch);
          // bge: CLS pooling + L2 normalisation (cosine distance in pgvector expects unit vectors)
          const t = await extractor(slice, { pooling: 'cls', normalize: true });
          const rows = t.tolist() as number[][];
          out.push(...rows);
        }
        return out;
      },
    };
  })();
  return localEmbedder;
}

/** Loads local models up front (no-op for API-backed embeddings). Returns what was loaded. */
export async function warmLocalModels(): Promise<string[]> {
  const loaded: string[] = [];
  if (providerFor(config.models.embed) === 'local') {
    await getLocalEmbedder(config.models.embed);
    loaded.push(config.models.embed);
  }
  return loaded;
}

export async function embedTexts(texts: string[], signal?: AbortSignal): Promise<{ vectors: number[][]; usage: UsageReport }> {
  const model = config.models.embed;
  if (texts.length === 0) {
    return { vectors: [], usage: { model, inputTokens: 0, outputTokens: 0, costUsd: 0 } };
  }
  if (providerFor(model) === 'local') {
    const e = await getLocalEmbedder(model);
    const vectors = await e.embed(texts);
    const dim = vectors[0]?.length ?? 0;
    if (dim !== config.embedDim) {
      throw new Error(`embedding model ${model} returned ${dim} dimensions but EMBED_DIM is ${config.embedDim}`);
    }
    const inputTokens = texts.reduce((n, t) => n + countTokens(t), 0);
    return { vectors, usage: { model, inputTokens, outputTokens: 0, costUsd: 0 } };
  }
  requireKeys(['openai']);
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
  /**
   * Re-chunk the provider stream into word-sized deltas paced a few ms apart. Anthropic emits Opus 5 text in
   * bursts of 80–200 characters, which a UI shows as sentence-sized jumps; smoothing makes it flow.
   * Off for evals (no UI, and the delay would add seconds per answer).
   */
  smooth?: boolean;
}

const SMOOTH_DELAY_MS = 8;

export interface AnswerStreamResult {
  /** Text deltas as the provider emits them. */
  textStream: AsyncIterable<string>;
  /**
   * Resolves after the stream ends (or is aborted) with usage + finish reason.
   * REJECTS with the provider error when the stream failed: the AI SDK swallows stream errors (they only reach
   * `onError`), which would otherwise surface as a silent empty answer with finishReason "error".
   */
  final: Promise<{ usage: UsageReport; finishReason: string; text: string }>;
}

export function streamAnswer(opts: AnswerStreamOptions): AnswerStreamResult {
  const model = config.models.answer;
  let streamError: unknown;
  const result = streamText({
    model: chatModel(model),
    system: opts.system,
    prompt: opts.user,
    onError: ({ error }) => {
      streamError ??= error;
    },
    maxOutputTokens: opts.maxOutputTokens ?? 1024,
    // no `temperature`: sampling params are not supported on claude-opus-5 (the SDK would drop it with a warning)
    ...(opts.smooth ? { experimental_transform: smoothStream({ chunking: 'word', delayInMs: SMOOTH_DELAY_MS }) } : {}),
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
    if (streamError !== undefined && !opts.signal?.aborted) throw streamError;
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

// ---------- judge (structured; different family when an OpenAI key exists) ----------

export async function judgeObject<T>(opts: {
  system: string;
  user: string;
  schema: z.ZodType<T>;
  signal?: AbortSignal;
}): Promise<{ object: T; usage: UsageReport }> {
  const model = config.models.judge;
  const provider = providerFor(model);
  const res = await generateText({
    model: chatModel(model),
    system: opts.system,
    prompt: opts.user,
    output: Output.object({ schema: opts.schema }),
    ...(opts.signal ? { abortSignal: opts.signal } : {}),
    providerOptions:
      provider === 'anthropic'
        ? { anthropic: { thinking: { type: 'adaptive' }, effort: 'low' } }
        : { openai: { reasoningEffort: 'low' } },
  });
  const inputTokens = res.usage.inputTokens ?? 0;
  const outputTokens = res.usage.outputTokens ?? 0;
  if (res.output === undefined) throw new Error('judge returned no structured output');
  return {
    object: res.output as T,
    usage: { model, inputTokens, outputTokens, costUsd: costUsd(model, { inputTokens, outputTokens }) },
  };
}
