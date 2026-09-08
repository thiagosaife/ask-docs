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
    judge: env('JUDGE_MODEL', 'gpt-5-mini'),
    embed: env('EMBED_MODEL', 'text-embedding-3-small'),
  },

  /** Embedding dimension. Must match migrations/0001_init.sql. */
  embedDim: 1536,

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

export type Config = typeof config;
