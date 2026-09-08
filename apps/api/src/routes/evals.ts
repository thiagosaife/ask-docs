import { Hono } from 'hono';
import { sql } from '../lib/db.js';

export interface EvalRunSummary {
  id: string;
  version: string;
  ranAt: string;
  nCases: number;
  recallAt5: number;
  faithfulness: number;
  injectionPassRate: number;
  costPerAnswerUsd: number;
  answerModel: string;
  judgeModel: string;
  embedModel: string;
}

type Row = Record<string, unknown>;

const SUMMARY_COLS = sql`id, version, ran_at, n_cases, recall_at5, faithfulness, injection_pass_rate,
  cost_per_answer_usd, answer_model, judge_model, embed_model`;

function toSummary(r: Row): EvalRunSummary {
  return {
    id: String(r.id),
    version: String(r.version),
    ranAt: new Date(r.ran_at as string).toISOString(),
    nCases: Number(r.n_cases),
    recallAt5: Number(r.recall_at5),
    faithfulness: Number(r.faithfulness),
    injectionPassRate: Number(r.injection_pass_rate),
    costPerAnswerUsd: Number(r.cost_per_answer_usd),
    answerModel: String(r.answer_model),
    judgeModel: String(r.judge_model),
    embedModel: String(r.embed_model),
  };
}

export const evalsRoute = new Hono();

/**
 * Public, read-only.
 *   GET /evals          → latest run per version
 *   GET /evals?all=1    → every run
 *   GET /evals?id=<id>  → one run with per-case details
 */
evalsRoute.get('/evals', async (c) => {
  const id = c.req.query('id');
  if (id) {
    const [run] = await sql<Row[]>`select * from eval_runs where id = ${id}`;
    if (!run) return c.json({ error: { code: 'not_found' } }, 404);
    return c.json({ ...toSummary(run), details: run.details });
  }
  const rows =
    c.req.query('all') === '1'
      ? await sql<Row[]>`select ${SUMMARY_COLS} from eval_runs order by ran_at desc`
      : await sql<Row[]>`select distinct on (version) ${SUMMARY_COLS} from eval_runs order by version, ran_at desc`;
  const runs = rows.map(toSummary).sort((a, b) => b.ranAt.localeCompare(a.ranAt));
  return c.json({ runs });
});
