/**
 * SSE contract for POST /ask. Every `data:` payload is a JSON object; the widget never parses prose.
 * Frame order: meta → status(retrieving) → status(generating) → delta* (citation interleaved) → done | error
 */
export interface Citation {
  n: number;
  chunkId: string;
  url: string;
  title: string;
}

export interface AskUsage {
  inputTokens: number;
  outputTokens: number;
  embedTokens: number;
  costUsd: number;
}

export type AskErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'origin_forbidden'
  | 'rate_limited'
  | 'budget_exceeded'
  | 'upstream'
  | 'internal';

export type AskEvent =
  | { event: 'meta'; data: { answerId: string; traceId: string; version: string; model: string } }
  | { event: 'status'; data: { phase: 'retrieving' | 'generating' } }
  | { event: 'delta'; data: { text: string } }
  | { event: 'citation'; data: Citation }
  | { event: 'done'; data: { usage: AskUsage; citations: Citation[]; traceId: string; finishReason: string } }
  | { event: 'error'; data: { code: AskErrorCode; message: string; retryable: boolean } };

export function encodeSse(e: AskEvent): string {
  return `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`;
}
