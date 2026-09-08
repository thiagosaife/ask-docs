/**
 * Checks that every labelled "path#anchor" in questions.json exists among the indexed chunks.
 * Hand labels drift when docs change; this keeps recall@5 honest.
 */
import { sql } from '@ask-docs/api/db';
import { config } from '@ask-docs/api/config';
import { loadCases, parseSection } from './lib.js';

export interface LabelProblem {
  caseId: string;
  section: string;
  hint?: string;
}

export async function validateLabels(tenant = config.demoSite.tenant): Promise<LabelProblem[]> {
  const rows = await sql<{ path: string; anchors: string[] }[]>`
    select path, anchors from chunks where tenant = ${tenant}`;
  const byPath = new Map<string, Set<string>>();
  for (const r of rows) {
    const set = byPath.get(r.path) ?? new Set<string>();
    for (const a of r.anchors) set.add(a);
    byPath.set(r.path, set);
  }
  const problems: LabelProblem[] = [];
  for (const c of loadCases()) {
    for (const s of c.relevant ?? []) {
      const { path, anchor } = parseSection(s);
      const anchors = byPath.get(path);
      if (!anchors) {
        problems.push({ caseId: c.id, section: s, hint: 'page not indexed' });
        continue;
      }
      if (anchor && !anchors.has(anchor)) {
        const hint = [...anchors].filter((a) => a.includes(anchor.split('-')[0] ?? '')).slice(0, 5).join(', ') || [...anchors].slice(0, 6).join(', ');
        problems.push({ caseId: c.id, section: s, hint });
      }
    }
  }
  return problems;
}

if (process.argv[1]?.endsWith('validate.ts')) {
  const problems = await validateLabels();
  console.log(problems.length ? JSON.stringify(problems, null, 2) : 'all labelled sections exist in the index');
  await sql.end({ timeout: 5 });
}
