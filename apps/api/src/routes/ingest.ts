import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { z } from 'zod';
import { config } from '../lib/config.js';
import { ingestSite } from '../lib/ingest.js';

export const CACHE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.cache', 'html');

const body = z.object({
  tenant: z.string().min(1).max(64).default(config.demoSite.tenant),
  baseUrl: z.string().url().default(config.demoSite.baseUrl),
  include: z.array(z.string()).default(['/guide/', '/api/']),
  exclude: z.array(z.string()).default([]),
  maxPages: z.number().int().positive().optional(),
  force: z.boolean().default(false),
});

export const ingestRoute = new Hono();

/** Admin-only, long-running. Returns the ingest report when done. */
ingestRoute.post('/ingest', async (c) => {
  const key = c.req.header('x-admin-key');
  if (!key || key !== config.adminKey) return c.json({ error: { code: 'unauthorized', message: 'admin key required' } }, 401);
  const parsed = body.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: { code: 'bad_request', message: parsed.error.message } }, 400);
  const p = parsed.data;
  try {
    const report = await ingestSite({
      tenant: p.tenant,
      baseUrl: p.baseUrl,
      include: p.include,
      exclude: p.exclude,
      cacheDir: CACHE_DIR,
      ...(p.maxPages ? { maxPages: p.maxPages } : {}),
      force: p.force,
      log: (m) => console.log('[ingest]', m),
    });
    return c.json(report);
  } catch (e) {
    console.error('[ingest] failed', e);
    return c.json({ error: { code: 'internal', message: (e as Error).message } }, 500);
  }
});
