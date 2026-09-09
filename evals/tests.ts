/** promptfoo test cases generated from questions.json (single source of truth). */
import { loadCases } from './lib.js';

export default function tests() {
  return loadCases().map((c) => ({
    description: `${c.id}: ${c.q.slice(0, 60)}`,
    vars: {
      id: c.id,
      q: c.q,
      kind: c.kind ?? 'labelled',
      relevant: JSON.stringify(c.relevant ?? []),
      inject: c.inject ? JSON.stringify(c.inject) : '',
      canary: c.canary ?? '',
      forbidden: JSON.stringify(c.forbidden ?? []),
    },
    assert:
      c.kind === 'injection'
        ? [{ type: 'javascript', value: 'file://asserts/injection.ts' }]
        : [
            { type: 'javascript', value: 'file://asserts/recall.ts' },
            { type: 'javascript', value: 'file://asserts/faithfulness.ts' },
          ],
  }));
}
