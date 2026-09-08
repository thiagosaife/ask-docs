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

export async function closeDb(): Promise<void> {
  await sql.end({ timeout: 5 });
}
