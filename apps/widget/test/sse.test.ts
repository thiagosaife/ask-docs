import { describe, expect, it, vi } from 'vitest';
import { askStream, SseParser, type AskEvent } from '../src/sse.js';

describe('SseParser', () => {
  it('parses frames split arbitrarily across chunks', () => {
    const p = new SseParser();
    const a = p.push('event: meta\ndata: {"answerId":"a","traceId":"t","version":"v","model":"m"}\n\nevent: del');
    expect(a).toEqual([{ event: 'meta', data: { answerId: 'a', traceId: 't', version: 'v', model: 'm' } }]);
    const b = p.push('ta\ndata: {"text":"Hel');
    expect(b).toEqual([]);
    const c = p.push('lo"}\n\n: keep-alive\n\nevent: citation\ndata: {"n":1,"chunkId":"c","url":"https://x","title":"T"}\n\n');
    expect(c).toEqual([
      { event: 'delta', data: { text: 'Hello' } },
      { event: 'citation', data: { n: 1, chunkId: 'c', url: 'https://x', title: 'T' } },
    ]);
  });

  it('drops frames with unknown events or non-JSON data instead of throwing', () => {
    const p = new SseParser();
    expect(p.push('event: weird\ndata: {"x":1}\n\nevent: delta\ndata: not json\n\nevent: delta\ndata: {"text":"ok"}\n\n')).toEqual([
      { event: 'delta', data: { text: 'ok' } },
    ]);
  });
});

function streamResponse(frames: string[], opts: { status?: number; dropAfter?: number } = {}): Response {
  let i = 0;
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (opts.dropAfter !== undefined && i >= opts.dropAfter) {
        controller.error(new Error('connection reset'));
        return;
      }
      if (i < frames.length) controller.enqueue(enc.encode(frames[i++]!));
      else controller.close();
    },
  });
  return new Response(body, { status: opts.status ?? 200, headers: { 'content-type': 'text/event-stream' } });
}

const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

describe('askStream', () => {
  const base = { apiUrl: 'http://api.test', siteToken: 'pk', question: 'q' };

  it('returns done and forwards every event in order', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse([frame('status', { phase: 'retrieving' }), frame('delta', { text: 'a' }), frame('done', { usage: {}, citations: [], traceId: 't', finishReason: 'stop' })])));
    const events: AskEvent[] = [];
    const outcome = await askStream({ ...base, signal: new AbortController().signal, onEvent: (e) => events.push(e) });
    expect(outcome).toBe('done');
    expect(events.map((e) => e.event)).toEqual(['status', 'delta', 'done']);
    const call = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[0]).toBe('http://api.test/ask');
    expect((call[1] as RequestInit).headers).toMatchObject({ authorization: 'Bearer pk' });
  });

  it('reports interrupted when the stream ends without a done frame', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse([frame('delta', { text: 'partial' })])));
    const outcome = await askStream({ ...base, signal: new AbortController().signal, onEvent: () => {} });
    expect(outcome).toBe('interrupted');
  });

  it('reports interrupted when the connection errors mid-stream', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse([frame('delta', { text: 'a' }), frame('delta', { text: 'b' })], { dropAfter: 1 })));
    const outcome = await askStream({ ...base, signal: new AbortController().signal, onEvent: () => {} });
    expect(outcome).toBe('interrupted');
  });

  it('reports aborted when the caller stops', async () => {
    const ac = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_u: string, init: RequestInit) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(frame('delta', { text: 'a' })));
            init.signal!.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
          },
        });
        return new Response(body, { status: 200 });
      }),
    );
    const outcome = askStream({ ...base, signal: ac.signal, onEvent: (e) => e.event === 'delta' && ac.abort() });
    expect(await outcome).toBe('aborted');
  });

  it('surfaces structured HTTP errors as an error event', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'rate_limited', message: 'slow down', retryable: true } }), { status: 429 })));
    const events: AskEvent[] = [];
    const outcome = await askStream({ ...base, signal: new AbortController().signal, onEvent: (e) => events.push(e) });
    expect(outcome).toBe('error');
    expect(events[0]).toEqual({ event: 'error', data: { code: 'rate_limited', message: 'slow down', retryable: true } });
  });

  it('surfaces network failures as a retryable error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const events: AskEvent[] = [];
    expect(await askStream({ ...base, signal: new AbortController().signal, onEvent: (e) => events.push(e) })).toBe('error');
    expect(events[0]!.event).toBe('error');
    expect((events[0] as { data: { retryable: boolean } }).data.retryable).toBe(true);
  });
});
