import { recallAt5, record, type RetrievedLike } from '../lib.js';

interface Ctx {
  vars: Record<string, unknown>;
  providerResponse?: { metadata?: { retrieved?: RetrievedLike[] } };
}

/** recall@5 = |relevant sections hit by the 5 kept chunks| / |relevant sections| */
export default function recall(_output: string, ctx: Ctx) {
  const relevant = JSON.parse(String(ctx.vars.relevant ?? '[]')) as string[];
  const retrieved = ctx.providerResponse?.metadata?.retrieved ?? [];
  const score = recallAt5(relevant, retrieved);
  record('recall', { caseId: ctx.vars.id, score, relevant, retrieved: retrieved.map((r) => `${r.path}#${r.anchor ?? ''}`) });
  return {
    pass: score > 0,
    score,
    reason: `recall@5 ${score.toFixed(2)} (${relevant.length} relevant; top-5: ${retrieved.map((r) => `${r.path}#${r.anchor ?? ''}`).join(', ')})`,
    namedScores: { recallAt5: score },
  };
}
