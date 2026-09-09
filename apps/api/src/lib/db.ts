import postgres from 'postgres';
import { config } from './config.js';

export const sql = postgres(config.databaseUrl, {
  max: 10,
  onnotice: () => {},
  transform: { undefined: null },
});

/** pgvector literal: '[0.1,0.2,...]' */
export function toVector(v: number[]): string {
  return `[${v.join(',')}]`;
}

export interface SiteRow {
  id: string;
  tenant: string;
  name: string;
  base_url: string;
  public_token: string;
  allowed_origins: string[];
  daily_answer_budget: number;
}

export interface ChunkRow {
  id: string;
  tenant: string;
  document_id: string;
  ord: number;
  url: string;
  path: string;
  anchor: string | null;
  anchors: string[];
  heading_path: string[];
  header: string;
  content: string;
  token_count: number;
}

/** Current dimension of chunks.embedding (pgvector stores it as the column typmod). */
export async function embeddingColumnDim(): Promise<number | null> {
  const [row] = await sql<{ dim: number | null }[]>`
    select atttypmod as dim from pg_attribute
    where attrelid = 'chunks'::regclass and attname = 'embedding' and not attisdropped`;
  return row?.dim ?? null;
}

/**
 * Makes chunks.embedding match config.embedDim. Changing the dimension drops every indexed document
 * (they must be re-embedded anyway); documents are removed too so ingest does not skip them by content hash.
 */
export async function ensureEmbeddingDim(dim: number, log: (m: string) => void = console.log): Promise<void> {
  const current = await embeddingColumnDim();
  if (current === dim) return;
  log(`chunks.embedding is vector(${current}) but EMBED_DIM is ${dim}: resizing (drops indexed documents, run pnpm ingest again)`);
  await sql.begin(async (tx) => {
    await tx`delete from documents`;
    await tx`drop index if exists chunks_embedding_hnsw`;
    await tx.unsafe(`alter table chunks alter column embedding type vector(${Number(dim)})`);
    await tx`create index chunks_embedding_hnsw on chunks using hnsw (embedding vector_cosine_ops)`;
  });
}

export async function closeDb(): Promise<void> {
  await sql.end({ timeout: 5 });
}
