import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { config } from './lib/config.js';
import { sql } from './lib/db.js';
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
  const [row] = await sql<{ chunks: number }[]>`select count(*)::int as chunks from chunks`;
  const chunks = row?.chunks ?? 0;
  return c.json({ ok: true, version: VERSION, chunks, models: config.models });
});

app.route('/', askRoute);
app.route('/', ingestRoute);
app.route('/', evalsRoute);

app.notFound((c) => c.json({ error: { code: 'not_found' } }, 404));
app.onError((e, c) => {
  console.error(e);
  return c.json({ error: { code: 'internal', message: 'internal error' } }, 500);
});

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`ask-docs api ${VERSION} listening on http://localhost:${info.port}`);
});

export { app };
