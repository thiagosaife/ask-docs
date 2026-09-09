import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { config, providerStatus } from './lib/config.js';
import { embeddingColumnDim, sql } from './lib/db.js';
import { describeError, describeErrorForClient } from './lib/errors.js';
import { warmLocalModels } from './lib/llm.js';
import { warmReranker } from './lib/rerank.js';
import { VERSION } from './lib/version.js';
import { askRoute } from './routes/ask.js';
import { ingestRoute } from './routes/ingest.js';
import { evalsRoute } from './routes/evals.js';

const app = new Hono();

app.use(logger((s) => console.log(s.replace(/question=[^&\s]+/g, 'question=<redacted>'))));

// CORS: reflect only origins that some site allows. The per-site check happens again in /ask.
app.use(
  '/ask',
  cors({
    origin: async (origin) => {
      const [row] = await sql<{ ok: boolean }[]>`select exists(select 1 from sites where ${origin} = any(allowed_origins)) as ok`;
      return row?.ok ? origin : '';
    },
    allowMethods: ['POST', 'OPTIONS'],
    allowHeaders: ['authorization', 'content-type'],
    maxAge: 600,
  }),
);
app.use('/evals', cors({ origin: '*', allowMethods: ['GET'] }));

app.get('/health', async (c) => {
  const [row] = await sql<{ chunks: number; models: string[] }[]>`
    select count(*)::int as chunks, coalesce(array_agg(distinct embed_model), '{}') as models from chunks`;
  const chunks = row?.chunks ?? 0;
  const providers = providerStatus();
  const columnDim = await embeddingColumnDim();
  const problems: string[] = [];
  if (!providers.answer.ready) problems.push(`${providers.answer.provider} key missing for answer model ${providers.answer.model}`);
  if (!providers.embed.ready) problems.push(`${providers.embed.provider} key missing for embed model ${providers.embed.model}`);
  if (chunks === 0) problems.push('no documents indexed: run pnpm ingest');
  if (columnDim !== config.embedDim) problems.push(`chunks.embedding is vector(${columnDim}) but EMBED_DIM is ${config.embedDim}: run pnpm db:migrate`);
  const stale = (row?.models ?? []).filter((m) => m !== config.models.embed);
  if (stale.length) problems.push(`index embedded with ${stale.join(', ')}, config says ${config.models.embed}: run pnpm ingest --force`);
  return c.json({ ok: problems.length === 0, version: VERSION, chunks, providers, embedDim: config.embedDim, problems });
});

app.route('/', askRoute);
app.route('/', ingestRoute);
app.route('/', evalsRoute);

app.notFound((c) => c.json({ error: { code: 'not_found' } }, 404));
app.onError((e, c) => {
  const d = describeErrorForClient(e);
  console.error(`[api] ${d.code}: ${d.message}`);
  return c.json({ error: { code: d.code, message: d.message, retryable: d.retryable } }, d.status as 500);
});

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`ask-docs api ${VERSION} listening on http://localhost:${info.port}`);
  for (const [role, p] of Object.entries(providerStatus())) {
    console.log(`  ${role.padEnd(6)} ${p.model} via ${p.provider}${p.ready ? '' : '  ← KEY MISSING'}`);
  }
  // Local ONNX models: download/load now so the first question does not pay for it and failures show up here.
  void Promise.all([warmLocalModels(), warmReranker()])
    .then(([embed, rerank]) => console.log(`  local models ready: ${[...embed, rerank].join(', ')}`))
    .catch((e) => console.error(`  local models FAILED: ${describeError(e).message}`));
});

export { app };
