import { createHash } from 'node:crypto';
import { config } from './config.js';
import { sql, toVector } from './db.js';
import { crawl } from './crawl.js';
import { chunkHtml, embedText } from './chunk.js';
import { embedTexts } from './llm.js';

export interface IngestOptions {
  tenant: string;
  baseUrl: string;
  include: string[]; // path prefixes, e.g. ['/guide/', '/api/']
  exclude?: string[];
  cacheDir: string;
  maxPages?: number;
  force?: boolean; // re-embed even if content hash unchanged
  log?: (msg: string) => void;
}

export interface IngestReport {
  pages: number;
  documentsUpdated: number;
  documentsSkipped: number;
  chunks: number;
  embedTokens: number;
  embedCostUsd: number;
  tokenStats: { min: number; max: number; mean: number };
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export async function ingestSite(opts: IngestOptions): Promise<IngestReport> {
  const log = opts.log ?? console.log;
  const pages = await crawl({
    baseUrl: opts.baseUrl,
    include: opts.include.map((p) => new RegExp('^' + p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))),
    exclude: (opts.exclude ?? []).map((p) => new RegExp('^' + p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))),
    cacheDir: opts.cacheDir,
    ...(opts.maxPages ? { maxPages: opts.maxPages } : {}),
    log,
  });
  log(`crawled ${pages.length} pages`);

  const report: IngestReport = {
    pages: pages.length,
    documentsUpdated: 0,
    documentsSkipped: 0,
    chunks: 0,
    embedTokens: 0,
    embedCostUsd: 0,
    tokenStats: { min: Infinity, max: 0, mean: 0 },
  };
  let tokenSum = 0;
  let embeddedChunks = 0;

  for (const page of pages) {
    const doc = chunkHtml({
      url: page.url,
      html: page.html,
      minTokens: config.chunking.minTokens,
      maxTokens: config.chunking.maxTokens,
    });
    if (doc.chunks.length === 0) {
      log(`no chunks: ${page.url}`);
      continue;
    }
    const contentHash = sha(doc.chunks.map((c) => embedText(c)).join('\n---\n'));
    const [existing] = await sql<{ id: string; content_hash: string }[]>`
      select id, content_hash from documents where tenant = ${opts.tenant} and url = ${page.url}`;
    if (existing && existing.content_hash === contentHash && !opts.force) {
      report.documentsSkipped++;
      const [cnt] = await sql<{ n: number }[]>`select count(*)::int as n from chunks where document_id = ${existing.id}`;
      const n = cnt?.n ?? 0;
      report.chunks += n;
      continue;
    }

    const { vectors, usage } = await embedTexts(doc.chunks.map((c) => embedText(c)));
    report.embedTokens += usage.inputTokens;
    report.embedCostUsd += usage.costUsd;

    await sql.begin(async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        insert into documents (tenant, url, path, title, content_hash, fetched_at)
        values (${opts.tenant}, ${page.url}, ${doc.path}, ${doc.title}, ${contentHash}, now())
        on conflict (tenant, url) do update set
          path = excluded.path, title = excluded.title, content_hash = excluded.content_hash, fetched_at = now()
        returning id`;
      const documentId = row!.id;
      await tx`delete from chunks where document_id = ${documentId}`;
      for (let i = 0; i < doc.chunks.length; i++) {
        const c = doc.chunks[i]!;
        const v = vectors[i]!;
        await tx`
          insert into chunks (tenant, document_id, ord, url, path, anchor, anchors, heading_path, header, content,
                              token_count, content_hash, embed_model, embedding)
          values (${opts.tenant}, ${documentId}, ${c.ord}, ${c.url}, ${c.path}, ${c.anchor}, ${tx.array(c.anchors)},
                  ${tx.array(c.headingPath)}, ${c.header}, ${c.content}, ${c.tokenCount},
                  ${sha(embedText(c))}, ${config.models.embed}, ${toVector(v)}::vector)`;
      }
    });
    report.documentsUpdated++;
    report.chunks += doc.chunks.length;
    for (const c of doc.chunks) {
      embeddedChunks++;
      tokenSum += c.tokenCount;
      report.tokenStats.min = Math.min(report.tokenStats.min, c.tokenCount);
      report.tokenStats.max = Math.max(report.tokenStats.max, c.tokenCount);
    }
    log(`indexed ${doc.path} (${doc.chunks.length} chunks)`);
  }
  report.tokenStats.mean = embeddedChunks ? Math.round(tokenSum / embeddedChunks) : 0;
  if (!Number.isFinite(report.tokenStats.min)) report.tokenStats.min = 0;
  report.embedCostUsd = Math.round(report.embedCostUsd * 1e6) / 1e6;
  return report;
}
