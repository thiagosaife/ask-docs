/**
 * The answer pipeline shared by POST /ask and the eval harness:
 *   embed question → hybrid retrieve 30 → cross-encoder keep 5 → stream grounded answer with [n] citations.
 * Emits structured AskEvents; never asks the caller to parse prose.
 */
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import type { ChunkRow } from './db.js';
import { streamAnswer } from './llm.js';
import { buildUserMessage, SYSTEM_PROMPT, type PromptDocument } from './prompt.js';
import { rerank } from './rerank.js';
import { retrieveCandidates } from './retrieve.js';
import { embedText } from './chunk.js';
import { CitationScanner } from './citations.js';
import type { AskEvent, Citation } from './sse.js';
import { tracer, truncate } from './trace.js';
import { VERSION } from './version.js';

export interface AnswerOptions {
  tenant: string;
  question: string;
  signal?: AbortSignal;
  /** hashed before it reaches the tracer */
  userKey?: string;
  sessionId?: string;
  /**
   * Eval-only: extra documents appended to the retrieved context (used for prompt-injection cases).
   * They are numbered after the retrieved ones so [n] stays consistent.
   */
  extraDocuments?: Array<{ header: string; content: string; url: string }>;
  emit: (e: AskEvent) => void | Promise<void>;
}

export interface RetrievedChunk {
  n: number;
  id: string;
  url: string;
  path: string;
  anchor: string | null;
  anchors: string[];
  header: string;
  rrf: number;
  rerankScore: number;
}

export interface AnswerResult {
  answerId: string;
  traceId: string;
  text: string;
  citations: Citation[];
  retrieved: RetrievedChunk[]; // the 5 kept
  candidates: number;
  usage: { inputTokens: number; outputTokens: number; embedTokens: number; costUsd: number };
  finishReason: string;
  aborted: boolean;
  /** full text of the kept chunks — for the faithfulness judge; never logged */
  context: Array<{ n: number; text: string }>;
}

export async function answerQuestion(opts: AnswerOptions): Promise<AnswerResult> {
  const answerId = randomUUID();
  const trace = tracer.start({
    name: 'ask',
    ...(opts.userKey ? { userKey: opts.userKey } : {}),
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    input: { question: truncate(opts.question), tenant: opts.tenant },
    metadata: { answerId, answerModel: config.models.answer, embedModel: config.models.embed },
    tags: [opts.tenant],
  });
  const emit = opts.emit;
  await emit({ event: 'meta', data: { answerId, traceId: trace.id, version: VERSION, model: config.models.answer } });

  // ---- retrieve ----
  await emit({ event: 'status', data: { phase: 'retrieving' } });
  const retrieveSpan = trace.span('retrieve', { candidates: config.retrieval.candidates });
  const { candidates, embedUsage } = await retrieveCandidates({
    tenant: opts.tenant,
    question: opts.question,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  retrieveSpan.end({
    count: candidates.length,
    top: candidates.slice(0, 10).map((c) => ({ id: c.id, url: c.url, rrf: c.rrf, vec: c.vec_rank, lex: c.lex_rank })),
  });

  const rerankSpan = trace.span('rerank', { in: candidates.length, keep: config.retrieval.keep });
  const kept = await rerank(
    opts.question,
    candidates.map((c) => ({ ...c, text: embedText(c) })),
    config.retrieval.keep,
  );
  rerankSpan.end({ kept: kept.map((k) => ({ id: k.id, url: k.url, score: k.rerankScore })) });

  const docs: PromptDocument[] = kept.map((c, i) => ({ n: i + 1, url: c.url, header: c.header, content: c.content }));
  const byN = new Map<number, { chunkId: string; url: string; title: string }>();
  kept.forEach((c: ChunkRow, i) => byN.set(i + 1, { chunkId: c.id, url: c.url, title: c.header }));
  for (const extra of opts.extraDocuments ?? []) {
    const n = docs.length + 1;
    docs.push({ n, url: extra.url, header: extra.header, content: extra.content });
    byN.set(n, { chunkId: `extra-${n}`, url: extra.url, title: extra.header });
  }

  // ---- generate ----
  await emit({ event: 'status', data: { phase: 'generating' } });
  const user = buildUserMessage(opts.question, docs);
  const gen = trace.generation('answer', { model: config.models.answer, input: { question: truncate(opts.question), docs: docs.map((d) => d.url) } });
  const scanner = new CitationScanner((n) => byN.has(n));
  const citations: Citation[] = [];
  let text = '';
  let aborted = false;

  const stream = streamAnswer({ system: SYSTEM_PROMPT, user, ...(opts.signal ? { signal: opts.signal } : {}) });
  try {
    for await (const delta of stream.textStream) {
      if (opts.signal?.aborted) {
        aborted = true;
        break;
      }
      text += delta;
      await emit({ event: 'delta', data: { text: delta } });
      for (const n of scanner.push(delta)) {
        const c = byN.get(n)!;
        const cit: Citation = { n, ...c };
        citations.push(cit);
        await emit({ event: 'citation', data: cit });
      }
    }
  } catch (e) {
    if (opts.signal?.aborted) aborted = true;
    else throw e;
  }
  if (opts.signal?.aborted) aborted = true;

  const final = await stream.final;
  const usage = {
    inputTokens: final.usage.inputTokens,
    outputTokens: final.usage.outputTokens,
    embedTokens: embedUsage.inputTokens,
    costUsd: Math.round((final.usage.costUsd + embedUsage.costUsd) * 1e6) / 1e6,
  };
  gen.end({
    output: truncate(text, 500),
    usage: { input: usage.inputTokens, output: usage.outputTokens },
    meta: { costUsd: usage.costUsd, citations: citations.map((c) => c.n), finishReason: aborted ? 'interrupted' : final.finishReason },
  });
  trace.update({
    output: { answerChars: text.length, citations: citations.length },
    metadata: { costUsd: usage.costUsd, aborted },
    ...(aborted ? { tags: [opts.tenant, 'interrupted'] } : {}),
  });

  if (!aborted) {
    await emit({ event: 'done', data: { usage, citations, traceId: trace.id, finishReason: final.finishReason } });
  }

  return {
    answerId,
    traceId: trace.id,
    text,
    citations,
    retrieved: kept.map((c, i) => ({
      n: i + 1,
      id: c.id,
      url: c.url,
      path: c.path,
      anchor: c.anchor,
      anchors: c.anchors,
      header: c.header,
      rrf: c.rrf,
      rerankScore: c.rerankScore,
    })),
    candidates: candidates.length,
    usage,
    finishReason: aborted ? 'interrupted' : final.finishReason,
    aborted,
    context: docs.map((d) => ({ n: d.n, text: `${d.header}\n\n${d.content}` })),
  };
}
