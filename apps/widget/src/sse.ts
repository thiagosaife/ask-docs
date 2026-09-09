/**
 * Client for POST /ask. Parses the SSE stream into typed events. No prose is ever parsed here:
 * every frame's `data:` is a JSON object produced by the server.
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

export type AskEvent =
  | { event: 'meta'; data: { answerId: string; traceId: string; version: string; model: string } }
  | { event: 'status'; data: { phase: 'retrieving' | 'generating' } }
  | { event: 'delta'; data: { text: string } }
  | { event: 'citation'; data: Citation }
  | { event: 'done'; data: { usage: AskUsage; citations: Citation[]; traceId: string; finishReason: string } }
  | { event: 'error'; data: { code: string; message: string; retryable: boolean } };

export type StreamOutcome = 'done' | 'error' | 'aborted' | 'interrupted';

/** Incremental SSE frame parser. Feed text chunks; get complete frames. */
export class SseParser {
  private buf = '';

  push(text: string): AskEvent[] {
    this.buf += text.replace(/\r\n/g, '\n');
    const out: AskEvent[] = [];
    let idx: number;
    while ((idx = this.buf.indexOf('\n\n')) !== -1) {
      const frame = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 2);
      const ev = parseFrame(frame);
      if (ev) out.push(ev);
    }
    return out;
  }
}

function parseFrame(frame: string): AskEvent | null {
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith(':')) continue; // comment / keep-alive
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
  }
  if (dataLines.length === 0) return null;
  let data: unknown;
  try {
    data = JSON.parse(dataLines.join('\n'));
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  switch (event) {
    case 'meta':
    case 'status':
    case 'delta':
    case 'citation':
    case 'done':
    case 'error':
      return { event, data } as AskEvent;
    default:
      return null;
  }
}

export interface AskRequest {
  apiUrl: string;
  siteToken: string;
  question: string;
  sessionId?: string;
  signal: AbortSignal;
  onEvent: (e: AskEvent) => void;
}

export async function askStream(req: AskRequest): Promise<StreamOutcome> {
  let res: Response;
  try {
    res = await fetch(new URL('/ask', req.apiUrl).toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${req.siteToken}`, accept: 'text/event-stream' },
      body: JSON.stringify({ question: req.question, ...(req.sessionId ? { sessionId: req.sessionId } : {}) }),
      signal: req.signal,
    });
  } catch (e) {
    if (req.signal.aborted) return 'aborted';
    req.onEvent({ event: 'error', data: { code: 'network', message: 'could not reach the answer service', retryable: true } });
    return 'error';
  }

  if (!res.ok) {
    let code = 'http_' + res.status;
    let message = res.statusText || 'request failed';
    let retryable = res.status === 429 || res.status >= 500;
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string; retryable?: boolean } };
      if (body.error) {
        code = body.error.code ?? code;
        message = body.error.message ?? message;
        retryable = body.error.retryable ?? retryable;
      }
    } catch {
      /* non-json error body */
    }
    req.onEvent({ event: 'error', data: { code, message, retryable } });
    return 'error';
  }

  if (!res.body) {
    req.onEvent({ event: 'error', data: { code: 'no_body', message: 'empty response', retryable: true } });
    return 'error';
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  let outcome: StreamOutcome = 'interrupted';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const ev of parser.push(decoder.decode(value, { stream: true }))) {
        req.onEvent(ev);
        if (ev.event === 'done') outcome = 'done';
        if (ev.event === 'error') outcome = 'error';
      }
      if (outcome !== 'interrupted') break;
    }
  } catch {
    if (req.signal.aborted) return 'aborted';
    // connection dropped mid-stream
  } finally {
    reader.cancel().catch(() => {});
  }
  if (req.signal.aborted) return 'aborted';
  return outcome;
}
