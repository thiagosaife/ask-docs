/**
 * pnpm --filter @ask-docs/api ingest [--max-pages N] [--force] [--dry-run] [--include /guide/,/api/]
 *   --dry-run  crawl + chunk only (no embeddings, no DB writes); useful before provider keys are set
 * Same code path as POST /ingest, without the HTTP hop (useful for the first long run).
 */
import { parseArgs } from 'node:util';
import { config } from '../lib/config.js';
import { closeDb } from '../lib/db.js';
import { ingestSite } from '../lib/ingest.js';
import { CACHE_DIR } from '../routes/ingest.js';

const { values } = parseArgs({
  options: {
    'max-pages': { type: 'string' },
    force: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    include: { type: 'string', default: '/guide/,/api/' },
    exclude: { type: 'string', default: '' },
  },
});

const t0 = Date.now();
const report = await ingestSite({
  tenant: config.demoSite.tenant,
  baseUrl: config.demoSite.baseUrl,
  include: values.include.split(',').filter(Boolean),
  exclude: values.exclude.split(',').filter(Boolean),
  cacheDir: CACHE_DIR,
  ...(values['max-pages'] ? { maxPages: Number(values['max-pages']) } : {}),
  force: values.force,
  dryRun: values['dry-run'],
  log: (m) => console.log('[ingest]', m),
});
console.log(JSON.stringify({ ...report, seconds: Math.round((Date.now() - t0) / 1000) }, null, 2));
if (!values['dry-run']) await closeDb();
