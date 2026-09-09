/**
 * Hybrid retrieval: cosine (pgvector HNSW) + lexical (tsvector, ts_rank_cd) fused with
 * Reciprocal Rank Fusion inside one SQL statement. Both arms are tenant-filtered.
 * Note: ts_rank_cd is BM25-style, not true BM25 (no length saturation / idf tuning).
 */
import { config } from './config.js';
import { sql, toVector, type ChunkRow } from './db.js';
import { AskError } from './errors.js';
import { embedTexts } from './llm.js';
import type { UsageReport } from './llm.js';

export interface Candidate extends ChunkRow {
  rrf: number;
  vec_rank: number | null;
  lex_rank: number | null;
}

export function rrfFuse<T extends { id: string }>(
  lists: T[][],
  k = config.retrieval.rrfK,
): Array<{ item: T; score: number; ranks: Array<number | null> }> {
  const scores = new Map<string, { item: T; score: number; ranks: Array<number | null> }>();
  lists.forEach((list, li) => {
    list.forEach((item, idx) => {
      const rank = idx + 1;
      const e = scores.get(item.id) ?? { item, score: 0, ranks: lists.map(() => null) };
      e.score += 1 / (k + rank);
      e.ranks[li] = rank;
      scores.set(item.id, e);
    });
  });
  return [...scores.values()].sort((a, b) => b.score - a.score);
}

export async function retrieveCandidates(opts: {
  tenant: string;
  question: string;
  limit?: number;
  signal?: AbortSignal;
}): Promise<{ candidates: Candidate[]; embedUsage: UsageReport }> {
  const limit = opts.limit ?? config.retrieval.candidates;
  const { vectors, usage } = await embedTexts([opts.question], opts.signal);
  const qv = toVector(vectors[0]!);
  const k = config.retrieval.rrfK;

  const rows = await sql<Candidate[]>`
    with vec as (
      select id, row_number() over (order by embedding <=> ${qv}::vector) as r
      from chunks
      where tenant = ${opts.tenant}
      order by embedding <=> ${qv}::vector
      limit ${limit}
    ),
    lex as (
      select id, row_number() over (order by ts_rank_cd(tsv, q) desc) as r
      from chunks, websearch_to_tsquery('english', ${opts.question}) q
      where tenant = ${opts.tenant} and tsv @@ q
      order by ts_rank_cd(tsv, q) desc
      limit ${limit}
    ),
    fused as (
      select coalesce(vec.id, lex.id) as id,
             coalesce(1.0 / (${k} + vec.r), 0) + coalesce(1.0 / (${k} + lex.r), 0) as rrf,
             vec.r as vec_rank, lex.r as lex_rank
      from vec full outer join lex on vec.id = lex.id
    )
    select c.id, c.tenant, c.document_id, c.ord, c.url, c.path, c.anchor, c.anchors, c.heading_path,
           c.header, c.content, c.token_count, f.rrf::float8 as rrf, f.vec_rank::int as vec_rank, f.lex_rank::int as lex_rank
    from fused f join chunks c on c.id = f.id
    order by f.rrf desc
    limit ${limit}`;

  if (rows.length === 0) await explainEmptyIndex(opts.tenant);
  return { candidates: rows, embedUsage: usage };
}

/** Zero candidates is almost always a setup problem; say which one instead of answering from nothing. */
async function explainEmptyIndex(tenant: string): Promise<void> {
  const [row] = await sql<{ n: number; models: string[] }[]>`
    select count(*)::int as n, coalesce(array_agg(distinct embed_model), '{}') as models
    from chunks where tenant = ${tenant}`;
  if (!row || row.n === 0) {
    throw new AskError('index_empty', `no documents are indexed for site "${tenant}" — run: pnpm ingest`, false, 503);
  }
  const other = row.models.filter((m) => m !== config.models.embed);
  if (other.length) {
    throw new AskError(
      'index_mismatch',
      `index was embedded with ${other.join(', ')} but EMBED_MODEL is ${config.models.embed} — run: pnpm db:migrate && pnpm ingest --force`,
      false,
      503,
    );
  }
}
