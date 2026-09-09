/**
 * Turns whatever the pipeline throws into a structured { code, message, retryable } that carries the
 * REAL reason (provider name, HTTP status, the provider's own error text) instead of a generic sentence.
 * Used by the SSE `error` frame, JSON error responses, the eval provider and the CLI.
 */
import { APICallError, RetryError } from 'ai';

export type AskErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'origin_forbidden'
  | 'rate_limited'
  | 'budget_exceeded'
  | 'config' // a required env var / key is missing
  | 'index_empty' // nothing ingested for this tenant
  | 'index_mismatch' // chunks embedded with a different model than the one configured
  | 'database' // Postgres unreachable / query failed
  | 'embed_model' // local embedding / re-rank model could not be loaded
  | 'empty_answer' // the stream ended without any text (and without a provider error)
  | 'provider_auth' // 401/403 from the model provider
  | 'provider_quota' // provider says no credits / quota exhausted (not retryable)
  | 'provider_rate_limited' // provider 429 (retryable)
  | 'provider_unavailable' // provider 5xx / overloaded (retryable)
  | 'provider_error' // any other provider 4xx
  | 'upstream'
  | 'internal';

export interface DescribedError {
  code: AskErrorCode;
  message: string;
  retryable: boolean;
  /** HTTP status to use when the error is returned as JSON instead of an SSE frame */
  status: number;
}

/** Error thrown by our own code with a known code attached. */
export class AskError extends Error {
  constructor(
    public readonly code: AskErrorCode,
    message: string,
    public readonly retryable = false,
    public readonly status = 500,
  ) {
    super(message);
    this.name = 'AskError';
  }
}

const KEY_PATTERN = /\b(sk-[A-Za-z0-9_-]{6,}|[A-Za-z0-9_-]{32,})\b/g;

/** Never let a key-looking token reach a client, even if a provider echoes it back. */
export function redactSecrets(s: string): string {
  return s.replace(KEY_PATTERN, (m) => (m.startsWith('sk-') ? 'sk-…' : m));
}

function providerFromUrl(url: string | undefined): string {
  if (!url) return 'model provider';
  try {
    const host = new URL(url).host;
    if (host.includes('anthropic')) return 'Anthropic';
    if (host.includes('openai')) return 'OpenAI';
    return host;
  } catch {
    return 'model provider';
  }
}

function providerDetail(body: string | undefined, fallback: string): { text: string; type?: string } {
  if (!body) return { text: fallback };
  try {
    const j = JSON.parse(body) as { error?: { message?: string; type?: string; code?: string } | string; message?: string };
    if (typeof j.error === 'string') return { text: j.error };
    if (j.error?.message) return { text: j.error.message, ...(j.error.type ? { type: j.error.type } : {}) };
    if (j.message) return { text: j.message };
  } catch {
    /* not json */
  }
  return { text: body.slice(0, 300) };
}

function describeApiCall(e: APICallError, attempts?: number): DescribedError {
  const provider = providerFromUrl(e.url);
  const status = e.statusCode ?? 0;
  const detail = providerDetail(e.responseBody, e.message);
  const suffix = attempts && attempts > 1 ? ` (after ${attempts} attempts)` : '';
  const message = `${provider} ${status || 'request'} error: ${detail.text}${suffix}`;
  const quota = /insufficient_quota|billing|credit|quota|balance/i.test(`${detail.type ?? ''} ${detail.text}`);

  if (status === 401 || status === 403) return { code: 'provider_auth', message, retryable: false, status: 502 };
  // OpenAI reports an empty balance as 429 insufficient_quota, Anthropic as 400 "credit balance is too low"
  if (quota && status < 500) return { code: 'provider_quota', message, retryable: false, status: 502 };
  if (status === 429) return { code: 'provider_rate_limited', message, retryable: true, status: 503 };
  if (status >= 500 || status === 0) return { code: 'provider_unavailable', message, retryable: true, status: 503 };
  return { code: 'provider_error', message, retryable: false, status: 502 };
}

export function describeError(err: unknown): DescribedError {
  const e = err as { message?: string; code?: string; name?: string; cause?: unknown } | undefined;

  if (err instanceof AskError) return { code: err.code, message: err.message, retryable: err.retryable, status: err.status };

  if (RetryError.isInstance(err)) {
    const last = err.lastError;
    if (APICallError.isInstance(last)) return describeApiCall(last, err.errors.length);
    return describeError(last);
  }
  if (APICallError.isInstance(err)) return describeApiCall(err);

  const msg = e?.message ?? String(err);

  if (/_API_KEY is not set/.test(msg)) return { code: 'config', message: `${msg} (add it to apps/api/.env)`, retryable: false, status: 500 };

  // postgres.js: ECONNREFUSED / CONNECT_TIMEOUT / 28P01 etc.
  if (e?.code === 'ECONNREFUSED' || e?.code === 'CONNECT_TIMEOUT' || /ECONNREFUSED|CONNECT_TIMEOUT/.test(msg)) {
    return { code: 'database', message: `cannot connect to Postgres: ${msg} (is the db container running? pnpm db:up)`, retryable: true, status: 503 };
  }
  if (e?.name === 'PostgresError') return { code: 'database', message: `Postgres error: ${msg}`, retryable: false, status: 500 };

  if (/transformers|onnx|Could not locate file|huggingface|Unable to get model file|local .* model/i.test(msg)) {
    return { code: 'embed_model', message: `local model failed to load: ${msg}`, retryable: true, status: 503 };
  }

  return { code: 'internal', message: msg || 'unknown error', retryable: false, status: 500 };
}

/** Same as describeError but with secrets redacted, for anything sent to a client. */
export function describeErrorForClient(err: unknown): DescribedError {
  const d = describeError(err);
  return { ...d, message: redactSecrets(d.message) };
}
