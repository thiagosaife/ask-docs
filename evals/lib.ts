import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EVALS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const RESULTS_DIR = path.join(EVALS_DIR, 'results');

export interface EvalCase {
  id: string;
  q: string;
  relevant?: string[]; // "guide/essentials/watchers#deep-watchers"
  kind?: 'injection';
  inject?: { header: string; content: string; url: string };
  canary?: string;
  forbidden?: string[];
}

export function loadCases(): EvalCase[] {
  return JSON.parse(readFileSync(path.join(EVALS_DIR, 'questions.json'), 'utf8')) as EvalCase[];
}

export function runId(): string {
  return process.env.EVAL_RUN_ID ?? 'adhoc';
}

/** Append a per-case record; run.ts merges these with promptfoo's own output. */
export function record(kind: string, data: Record<string, unknown>): void {
  mkdirSync(RESULTS_DIR, { recursive: true });
  appendFileSync(path.join(RESULTS_DIR, `cases-${runId()}.jsonl`), JSON.stringify({ kind, at: new Date().toISOString(), ...data }) + '\n');
}

export function parseSection(s: string): { path: string; anchor: string | null } {
  const [p, a] = s.split('#');
  return { path: (p ?? '').replace(/^\/+/, '').replace(/\.html$/, ''), anchor: a && a.length ? a : null };
}

export interface RetrievedLike {
  path: string;
  anchor: string | null;
  anchors: string[];
}

/** A relevant section is "hit" when a retrieved chunk is on that page and covers that heading id. */
export function sectionHit(section: string, retrieved: RetrievedLike[]): boolean {
  const { path: p, anchor } = parseSection(section);
  return retrieved.some((r) => r.path === p && (anchor === null || r.anchor === anchor || r.anchors.includes(anchor)));
}

export function recallAt5(relevant: string[], retrieved: RetrievedLike[]): number {
  if (relevant.length === 0) return 1;
  const hits = relevant.filter((s) => sectionHit(s, retrieved)).length;
  return hits / relevant.length;
}
