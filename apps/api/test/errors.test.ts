import { describe, expect, it } from 'vitest';
import { APICallError, RetryError } from 'ai';
import { AskError, describeError, describeErrorForClient, redactSecrets } from '../src/lib/errors.js';

const apiErr = (status: number, body: unknown, url = 'https://api.openai.com/v1/embeddings') =>
  new APICallError({ message: 'x', url, requestBodyValues: {}, statusCode: status, responseBody: JSON.stringify(body), isRetryable: status >= 500 });

describe('describeError', () => {
  it('surfaces the provider, status and the provider message for quota errors', () => {
    const d = describeError(apiErr(429, { error: { message: 'You have no credits remaining.', type: 'insufficient_quota' } }));
    expect(d.code).toBe('provider_quota');
    expect(d.retryable).toBe(false);
    expect(d.message).toBe('OpenAI 429 error: You have no credits remaining.');
  });

  it('treats an Anthropic 400 low-balance error as quota, not a generic 4xx', () => {
    const d = describeError(apiErr(400, { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } }, 'https://api.anthropic.com/v1/messages'));
    expect(d.code).toBe('provider_quota');
    expect(d.message).toBe('Anthropic 400 error: Your credit balance is too low to access the Anthropic API.');
  });

  it('unwraps RetryError to the last provider error and counts attempts', () => {
    const last = apiErr(529, { error: { message: 'Overloaded', type: 'overloaded_error' } }, 'https://api.anthropic.com/v1/messages');
    const d = describeError(new RetryError({ message: 'Failed after 3 attempts', reason: 'maxRetriesExceeded', errors: [last, last, last] }));
    expect(d.code).toBe('provider_unavailable');
    expect(d.retryable).toBe(true);
    expect(d.message).toBe('Anthropic 529 error: Overloaded (after 3 attempts)');
  });

  it('classifies auth, plain rate limits and other 4xx', () => {
    expect(describeError(apiErr(401, { error: { message: 'invalid x-api-key' } }, 'https://api.anthropic.com/v1/messages')).code).toBe('provider_auth');
    expect(describeError(apiErr(429, { error: { message: 'rate limit exceeded' } })).code).toBe('provider_rate_limited');
    expect(describeError(apiErr(400, { error: { message: 'bad model' } })).code).toBe('provider_error');
  });

  it('turns a missing key into a config error with a hint', () => {
    const d = describeError(new Error('ANTHROPIC_API_KEY is not set'));
    expect(d.code).toBe('config');
    expect(d.message).toContain('apps/api/.env');
  });

  it('keeps AskError codes and explains db connection failures', () => {
    expect(describeError(new AskError('index_empty', 'no documents', false, 503))).toMatchObject({ code: 'index_empty', status: 503 });
    const e = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5433'), { code: 'ECONNREFUSED' });
    expect(describeError(e)).toMatchObject({ code: 'database', retryable: true });
  });

  it('never sends a key-looking token to the client', () => {
    expect(redactSecrets('bad key sk-ant-api03-abcdefghijkl')).toBe('bad key sk-…');
    const d = describeErrorForClient(new Error('key sk-proj-ABCDEFGH1234 rejected'));
    expect(d.message).not.toContain('ABCDEFGH');
  });
});
