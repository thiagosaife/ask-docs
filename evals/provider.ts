/**
 * promptfoo custom provider: runs the real answer pipeline in-process (same code as POST /ask) so the
 * asserts get exact retrieved chunk ids and injection cases can append a poisoned <document>.
 */
import { answerQuestion } from '@ask-docs/api/answer';
import { config } from '@ask-docs/api/config';
import { describeError } from '@ask-docs/api/errors';
import { record } from './lib.js';

interface CallContext {
  vars: Record<string, unknown>;
}

export default class AskDocsProvider {
  id() {
    return 'ask-docs';
  }

  async callApi(prompt: string, context?: CallContext) {
    const vars = context?.vars ?? {};
    const inject = typeof vars.inject === 'string' && vars.inject ? (JSON.parse(vars.inject) as { header: string; content: string; url: string }) : undefined;
    const started = Date.now();
    try {
      const res = await answerQuestion({
        tenant: config.demoSite.tenant,
        question: prompt,
        ...(inject ? { extraDocuments: [inject] } : {}),
        userKey: 'eval',
        emit: () => {},
      });
      const metadata = {
        caseId: vars.id,
        answerId: res.answerId,
        traceId: res.traceId,
        retrieved: res.retrieved,
        citations: res.citations,
        context: res.context,
        usage: res.usage,
        finishReason: res.finishReason,
        latencyMs: Date.now() - started,
      };
      record('answer', { caseId: vars.id, kind: vars.kind ?? 'labelled', usage: res.usage, retrieved: res.retrieved.map((r) => r.url), citations: res.citations.map((c) => c.n), latencyMs: metadata.latencyMs });
      return {
        output: res.text,
        cost: res.usage.costUsd,
        tokenUsage: { prompt: res.usage.inputTokens, completion: res.usage.outputTokens, total: res.usage.inputTokens + res.usage.outputTokens },
        latencyMs: metadata.latencyMs,
        metadata,
      };
    } catch (e) {
      const d = describeError(e);
      record('answer-error', { caseId: vars.id, code: d.code, error: d.message });
      return { error: `${d.code}: ${d.message}` };
    }
  }
}
