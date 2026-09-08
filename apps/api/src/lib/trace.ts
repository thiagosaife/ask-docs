/**
 * Langfuse tracing with a no-PII policy:
 *  - user identifiers (IP, session) are HMAC-hashed with a server secret
 *  - questions are truncated to 200 chars
 *  - retrieved chunk *content* is never logged; only ids, urls, ranks and scores
 * When LANGFUSE keys are absent this is a no-op with the same interface.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { Langfuse } from 'langfuse';
import { config } from './config.js';

export interface TraceHandle {
  id: string;
  span(name: string, input?: unknown): { end(output?: unknown, meta?: Record<string, unknown>): void };
  generation(name: string, opts: { model: string; input?: unknown }): {
    end(opts: { output?: unknown; usage?: { input: number; output: number }; meta?: Record<string, unknown> }): void;
  };
  update(fields: { output?: unknown; metadata?: Record<string, unknown>; tags?: string[]; level?: 'DEFAULT' | 'WARNING' | 'ERROR' }): void;
}

export interface Tracer {
  enabled: boolean;
  start(opts: { name: string; userKey?: string; sessionId?: string; input: unknown; metadata?: Record<string, unknown>; tags?: string[] }): TraceHandle;
  flush(): Promise<void>;
}

export function hashId(value: string): string {
  return createHmac('sha256', config.traceHashSecret).update(value).digest('hex').slice(0, 24);
}

export function truncate(s: string, n = 200): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

const noopHandle = (): TraceHandle => ({
  id: randomUUID(),
  span: () => ({ end() {} }),
  generation: () => ({ end() {} }),
  update() {},
});

function createTracer(): Tracer {
  const { publicKey, secretKey, baseUrl } = config.langfuse;
  if (!publicKey || !secretKey) {
    return { enabled: false, start: noopHandle, flush: async () => {} };
  }
  const lf = new Langfuse({ publicKey, secretKey, baseUrl, flushAt: 5, flushInterval: 2000 });
  return {
    enabled: true,
    start(opts) {
      const trace = lf.trace({
        id: randomUUID(),
        name: opts.name,
        ...(opts.userKey ? { userId: hashId(opts.userKey) } : {}),
        ...(opts.sessionId ? { sessionId: hashId(opts.sessionId) } : {}),
        input: opts.input,
        metadata: { ...opts.metadata, version: config.version },
        tags: opts.tags ?? [],
      });
      return {
        id: trace.id,
        span(name, input) {
          const s = trace.span({ name, input });
          return { end: (output, meta) => s.end({ output, ...(meta ? { metadata: meta } : {}) }) };
        },
        generation(name, g) {
          const gen = trace.generation({ name, model: g.model, input: g.input });
          return {
            end: (o) =>
              gen.end({
                output: o.output,
                ...(o.usage ? { usage: { input: o.usage.input, output: o.usage.output, unit: 'TOKENS' } } : {}),
                ...(o.meta ? { metadata: o.meta } : {}),
              }),
          };
        },
        update(fields) {
          trace.update(fields);
        },
      };
    },
    flush: () => lf.flushAsync(),
  };
}

export const tracer: Tracer = createTracer();
