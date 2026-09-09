import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Always load apps/api/.env regardless of the process cwd (evals run from /evals).
loadEnv({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.env'), quiet: true });

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var ${name}`);
  return v;
}

function optional(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

const EMBED_DIMS: Record<string, number> = {
  'Xenova/bge-small-en-v1.5': 384,
  'Xenova/bge-base-en-v1.5': 768,
  'Xenova/all-MiniLM-L6-v2': 384,
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
};

export type Provider = 'anthropic' | 'openai' | 'local';

/** Which provider a model id is served by. */
export function providerFor(model: string): Provider {
  if (model.includes('/')) return 'local';
  if (model.startsWith('claude')) return 'anthropic';
  return 'openai';
}

export const config = {
  port: Number(env('PORT', '8787')),
  databaseUrl: env('DATABASE_URL', 'postgres://askdocs:askdocs@localhost:5433/askdocs'),

  anthropicApiKey: optional('ANTHROPIC_API_KEY'),
  openaiApiKey: optional('OPENAI_API_KEY'),

  langfuse: {
    publicKey: optional('LANGFUSE_PUBLIC_KEY'),
    secretKey: optional('LANGFUSE_SECRET_KEY'),
    baseUrl: env('LANGFUSE_BASE_URL', 'https://cloud.langfuse.com'),
  },

  adminKey: env('ADMIN_KEY', 'change-me'),
  traceHashSecret: env('TRACE_HASH_SECRET', 'change-me-too'),

  demoSite: {
    id: 'vuejs',
    tenant: 'vuejs',
    name: 'Vue.js docs',
    baseUrl: 'https://vuejs.org',
    token: env('DEMO_SITE_TOKEN', 'pk_demo_vuejs'),
    allowedOrigins: env(
      'DEMO_ALLOWED_ORIGINS',
      'http://localhost:5173,http://localhost:4173,http://127.0.0.1:5173',
    )
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },

  models: {
    answer: env('ANSWER_MODEL', 'claude-opus-5'),
    /**
     * Faithfulness judge. Anthropic-first: defaults to claude-sonnet-5 (a different model than the answerer,
     * same family). Set JUDGE_MODEL=gpt-5-mini for a cross-family judge (needs OpenAI credits).
     */
    judge: env('JUDGE_MODEL', 'claude-sonnet-5'),
    /**
     * Embeddings. Default is a local ONNX model (no key, no cost). Any id containing "/" is loaded with
     * transformers.js; "text-embedding-*" goes to OpenAI.
     */
    embed: env('EMBED_MODEL', 'Xenova/bge-small-en-v1.5'),
  },

  /** Embedding dimension; migrate.ts resizes chunks.embedding to match (re-ingest required after a change). */
  embedDim: Number(env('EMBED_DIM', String(EMBED_DIMS[process.env.EMBED_MODEL ?? 'Xenova/bge-small-en-v1.5'] ?? ''))) || undefined,

  retrieval: {
    candidates: 30,
    keep: 5,
    rrfK: 60,
  },

  chunking: {
    minTokens: 200,
    maxTokens: 800,
  },

  limits: {
    maxQuestionChars: 500,
    /** per-IP token bucket */
    ipBurst: 5,
    ipPerMinute: 10,
  },

  version: env('ASK_DOCS_VERSION', 'it1'),
} as const;

if (!config.embedDim) {
  throw new Error(`EMBED_DIM must be set for unknown embedding model "${config.models.embed}"`);
}

/** Provider per role plus whether its key is present — printed at startup and by GET /health. */
export function providerStatus() {
  const has = (p: Provider) => (p === 'anthropic' ? !!config.anthropicApiKey : p === 'openai' ? !!config.openaiApiKey : true);
  const row = (model: string) => ({ model, provider: providerFor(model), ready: has(providerFor(model)) });
  return { answer: row(config.models.answer), embed: row(config.models.embed), judge: row(config.models.judge) };
}

export type Config = typeof config;
