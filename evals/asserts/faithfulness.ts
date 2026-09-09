/**
 * Faithfulness judge (claim-level). Runs on the JUDGE model via the single provider module:
 * gpt-5-mini (different family than the claude-opus-5 answerer) when an OpenAI key exists,
 * otherwise claude-sonnet-5 (different model, same family). eval_runs.judge_model records which.
 *
 *   score = supported claims / all claims      (1.0 when the answer makes no factual claims,
 *                                               e.g. "the docs don't cover this")
 */
import { z } from 'zod';
import { judgeObject } from '@ask-docs/api/llm';
import { record } from '../lib.js';

interface Ctx {
  vars: Record<string, unknown>;
  providerResponse?: { metadata?: { context?: Array<{ n: number; text: string }> } };
}

const Verdict = z.object({
  claims: z.array(
    z.object({
      claim: z.string(),
      supported: z.boolean(),
      evidence: z.string().describe('short quote from the documents, or empty when unsupported'),
    }),
  ),
});

const JUDGE_SYSTEM = `You are a strict fact-checker for a documentation assistant. You will receive the documents that were given to the assistant and the answer it produced.

1. Split the answer into its atomic factual claims (statements about how the software behaves or should be used). Ignore hedges, meta statements such as "the documents do not cover X", and formatting.
2. For each claim decide whether it is directly supported by the documents. A claim is supported only if the documents state it or it follows trivially from them. Claims that rely on outside knowledge are unsupported, even if they are true.
3. Return every claim with a verdict and a short evidence quote.`;

export default async function faithfulness(output: string, ctx: Ctx) {
  const context = ctx.providerResponse?.metadata?.context ?? [];
  if (!output.trim()) return { pass: false, score: 0, reason: 'empty answer', namedScores: { faithfulness: 0 } };

  const user = `<documents>\n${context.map((d) => `<document n="${d.n}">\n${d.text}\n</document>`).join('\n')}\n</documents>\n\n<answer>\n${output}\n</answer>`;
  const { object, usage } = await judgeObject({ system: JUDGE_SYSTEM, user, schema: Verdict });
  const total = object.claims.length;
  const supported = object.claims.filter((c) => c.supported).length;
  const score = total === 0 ? 1 : supported / total;
  record('faithfulness', { caseId: ctx.vars.id, score, total, supported, judgeUsage: usage, unsupported: object.claims.filter((c) => !c.supported).map((c) => c.claim) });
  return {
    pass: score >= 0.8,
    score,
    reason: `${supported}/${total} claims supported` + (supported < total ? `; unsupported: ${object.claims.filter((c) => !c.supported).map((c) => c.claim).join(' | ')}` : ''),
    namedScores: { faithfulness: score },
  };
}
