import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { config } from '../lib/config.js';
import { bearerToken, originAllowed, siteForToken } from '../lib/auth.js';
import { answerQuestion } from '../lib/answer.js';
import { DailyBudget, MemoryTokenBucket } from '../lib/ratelimit.js';
import { encodeSse, type AskErrorCode, type AskEvent } from '../lib/sse.js';
import { tracer } from '../lib/trace.js';

const body = z.object({
  question: z.string().trim().min(1).max(config.limits.maxQuestionChars),
  sessionId: z.string().max(100).optional(),
});

export const ipLimiter = new MemoryTokenBucket({
  capacity: config.limits.ipBurst,
  refillPerMs: config.limits.ipPerMinute / 60_000,
});
export const siteBudget = new DailyBudget();

const ALLOW_NO_ORIGIN = process.env.ALLOW_NO_ORIGIN === '1';

function clientIp(headers: Headers): string {
  const fwd = headers.get('x-forwarded-for');
  return (fwd ? fwd.split(',')[0]!.trim() : headers.get('x-real-ip')) ?? 'unknown';
}

export const askRoute = new Hono();

askRoute.post('/ask', async (c) => {
  const fail = (status: number, code: AskErrorCode, message: string, retryable = false) =>
    c.json({ error: { code, message, retryable } }, status as 400);

  const token = bearerToken(c.req.header('authorization'));
  if (!token) return fail(401, 'unauthorized', 'missing site token');
  const site = await siteForToken(token);
  if (!site) return fail(401, 'unauthorized', 'unknown site token');
  const origin = c.req.header('origin');
  if (!originAllowed(origin, site, ALLOW_NO_ORIGIN)) return fail(403, 'origin_forbidden', 'origin not allowed for this site');

  const ip = clientIp(c.req.raw.headers);
  const rl = ipLimiter.take(`${site.id}:${ip}`);
  if (!rl.ok) {
    c.header('retry-after', String(Math.ceil(rl.retryAfterMs / 1000)));
    return fail(429, 'rate_limited', 'too many requests', true);
  }
  const budget = siteBudget.take(site.id, site.daily_answer_budget);
  if (!budget.ok) return fail(429, 'budget_exceeded', 'daily answer budget for this site is exhausted');

  const parsed = body.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return fail(400, 'bad_request', 'question is required (1–500 chars)');
  const { question, sessionId } = parsed.data;

  return streamSSE(
    c,
    async (stream) => {
      const ac = new AbortController();
      stream.onAbort(() => ac.abort());
      c.req.raw.signal.addEventListener('abort', () => ac.abort(), { once: true });
      const emit = async (e: AskEvent): Promise<void> => {
        await stream.write(encodeSse(e));
      };
      try {
        await answerQuestion({
          tenant: site.tenant,
          question,
          signal: ac.signal,
          userKey: ip,
          ...(sessionId ? { sessionId } : {}),
          emit,
        });
      } catch (e) {
        if (!ac.signal.aborted) {
          console.error('[ask] upstream error', (e as Error).message);
          await emit({ event: 'error', data: { code: 'upstream', message: 'the answer service failed, please retry', retryable: true } });
        }
      } finally {
        void tracer.flush();
      }
    },
    async (e, stream) => {
      console.error('[ask] stream error', e.message);
      await stream.write(encodeSse({ event: 'error', data: { code: 'internal', message: 'stream failed', retryable: true } }));
    },
  );
});
