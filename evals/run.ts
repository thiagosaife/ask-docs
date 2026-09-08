/**
 * pnpm eval
 *   1. validate that every labelled section exists in the index (warns, does not block)
 *   2. run promptfoo with the in-process provider
 *   3. aggregate → eval_runs row + results/<version>.json (+ latest.json) → served by GET /evals
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { config } from '@ask-docs/api/config';
import { sql, closeDb } from '@ask-docs/api/db';
import { VERSION } from '@ask-docs/api/version';
import { EVALS_DIR, RESULTS_DIR, loadCases } from './lib.js';
import { validateLabels } from './validate.js';

const require = createRequire(import.meta.url);

interface PfResult {
  vars: Record<string, unknown>;
  success: boolean;
  score: number;
  namedScores: Record<string, number>;
  cost?: number;
  latencyMs?: number;
  error?: string | null;
  response?: { output?: unknown; metadata?: Record<string, unknown>; cost?: number };
  gradingResult?: { pass: boolean; score: number; reason: string; componentResults?: Array<{ pass: boolean; score: number; reason: string }> } | null;
}

async function main() {
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  mkdirSync(RESULTS_DIR, { recursive: true });

  console.log(`ask-docs eval · version ${VERSION} · answer=${config.models.answer} judge=${config.models.judge} embed=${config.models.embed}`);
  const problems = await validateLabels();
  if (problems.length) {
    console.warn(`\n⚠ ${problems.length} labelled section(s) not found in the index:`);
    for (const p of problems) console.warn(`  ${p.caseId}: ${p.section}${p.hint ? `  (nearest on that page: ${p.hint})` : ''}`);
    console.warn('');
  }

  const out = path.join(RESULTS_DIR, `promptfoo-${runId}.json`);
  const entry = require.resolve('promptfoo/package.json').replace(/package\.json$/, 'dist/src/entrypoint.js');
  const args = ['--import', 'tsx', entry, 'eval', '-c', 'promptfooconfig.yaml', '-o', out, '--no-cache', '--no-progress-bar', '--no-table'];
  const filter = process.argv.slice(2);
  if (filter.length) args.push('--filter-pattern', filter.join('|'));
  const t0 = Date.now();
  const res = spawnSync(process.execPath, args, {
    cwd: EVALS_DIR,
    stdio: 'inherit',
    env: {
      ...process.env,
      EVAL_RUN_ID: runId,
      PROMPTFOO_DISABLE_TELEMETRY: '1',
      PROMPTFOO_DISABLE_UPDATE: '1',
      PROMPTFOO_DISABLE_SHARING: '1',
      PROMPTFOO_FAILED_TEST_EXIT_CODE: '0',
    },
  });
  if (res.status !== 0 || !existsSync(out)) {
    console.error(`promptfoo exited with ${res.status}; no output at ${out}`);
    process.exit(1);
  }

  const raw = JSON.parse(readFileSync(out, 'utf8')) as { results: { results: PfResult[] } };
  const rows = raw.results.results;
  const cases = new Map(loadCases().map((c) => [c.id, c]));

  const labelled = rows.filter((r) => r.vars.kind === 'labelled');
  const injections = rows.filter((r) => r.vars.kind === 'injection');
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const num = (r: PfResult, k: string) => (typeof r.namedScores?.[k] === 'number' ? r.namedScores[k]! : undefined);

  const recall = labelled.map((r) => num(r, 'recallAt5')).filter((x): x is number => x !== undefined);
  const faith = labelled.map((r) => num(r, 'faithfulness')).filter((x): x is number => x !== undefined);
  const inj = injections.map((r) => num(r, 'injectionPass')).filter((x): x is number => x !== undefined);
  const costs = rows.map((r) => r.response?.cost ?? r.cost ?? 0).filter((c) => c > 0);
  const errors = rows.filter((r) => r.error || (r.response && (r.response as { error?: string }).error));

  const details = rows.map((r) => {
    const c = cases.get(String(r.vars.id));
    const m = (r.response?.metadata ?? {}) as { retrieved?: Array<{ url: string; rerankScore: number }>; citations?: Array<{ n: number }>; usage?: unknown; traceId?: string };
    return {
      id: r.vars.id,
      kind: r.vars.kind,
      q: c?.q,
      relevant: c?.relevant,
      retrieved: m.retrieved?.map((x) => x.url),
      citations: m.citations?.map((x) => x.n),
      recallAt5: num(r, 'recallAt5'),
      faithfulness: num(r, 'faithfulness'),
      injectionPass: num(r, 'injectionPass'),
      costUsd: r.response?.cost ?? r.cost,
      latencyMs: r.latencyMs,
      traceId: m.traceId,
      reasons: r.gradingResult?.componentResults?.map((x) => x.reason),
      answer: typeof r.response?.output === 'string' ? r.response.output : undefined,
      error: r.error ?? undefined,
    };
  });

  const summary = {
    version: VERSION,
    ranAt: new Date().toISOString(),
    nCases: rows.length,
    nLabelled: labelled.length,
    nInjection: injections.length,
    nErrors: errors.length,
    recallAt5: round(mean(recall)),
    faithfulness: round(mean(faith)),
    injectionPassRate: round(mean(inj)),
    costPerAnswerUsd: round(mean(costs), 6),
    answerModel: config.models.answer,
    judgeModel: config.models.judge,
    embedModel: config.models.embed,
    durationSeconds: Math.round((Date.now() - t0) / 1000),
    labelProblems: problems,
  };

  const [row] = await sql<{ id: string }[]>`
    insert into eval_runs (version, n_cases, recall_at5, faithfulness, injection_pass_rate, cost_per_answer_usd,
                           answer_model, judge_model, embed_model, details)
    values (${VERSION}, ${rows.length}, ${summary.recallAt5}, ${summary.faithfulness}, ${summary.injectionPassRate},
            ${summary.costPerAnswerUsd}, ${config.models.answer}, ${config.models.judge}, ${config.models.embed},
            ${sql.json(JSON.parse(JSON.stringify({ summary, cases: details })))})
    returning id`;

  const file = path.join(RESULTS_DIR, `${VERSION.replace(/[^\w.+-]/g, '_')}.json`);
  const payload = { ...summary, evalRunId: row!.id, cases: details };
  writeFileSync(file, JSON.stringify(payload, null, 2));
  writeFileSync(path.join(RESULTS_DIR, 'latest.json'), JSON.stringify(payload, null, 2));

  console.log('\n' + JSON.stringify({ ...summary, labelProblems: problems.length, evalRunId: row!.id, file }, null, 2));
  await closeDb();
}

function round(x: number, d = 4): number {
  return Math.round(x * 10 ** d) / 10 ** d;
}

main().catch(async (e) => {
  console.error(e);
  await closeDb().catch(() => {});
  process.exit(1);
});
