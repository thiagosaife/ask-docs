import { describe, expect, it } from 'vitest';
import { CitationScanner } from '../src/lib/citations.js';

describe('CitationScanner', () => {
  it('emits each valid number once, in order of first sighting', () => {
    const s = new CitationScanner((n) => n >= 1 && n <= 5);
    expect(s.push('Use ref() for primitives [2]. Also see [1] and [2] again.')).toEqual([2, 1]);
    expect(s.push(' Finally [3].')).toEqual([3]);
    expect(s.referenced).toEqual([1, 2, 3]);
  });

  it('handles a marker split across deltas', () => {
    const s = new CitationScanner(() => true);
    expect(s.push('Deep watchers [')).toEqual([]);
    expect(s.push('4] traverse')).toEqual([4]);
    expect(s.push('[')).toEqual([]);
    expect(s.push('1')).toEqual([]);
    expect(s.push(']')).toEqual([1]);
  });

  it('ignores numbers outside the document range and non-citation brackets', () => {
    const s = new CitationScanner((n) => n <= 5);
    expect(s.push('arr[0] and [9] and [12] and [foo]')).toEqual([0]); // 0 is <=5 here but callers reject it
    const strict = new CitationScanner((n) => n >= 1 && n <= 5);
    expect(strict.push('arr[0] [9] [12] [foo] [3]')).toEqual([3]);
  });

  it('does not keep unrelated tails', () => {
    const s = new CitationScanner(() => true);
    s.push('text ending with bracket-ish [a');
    expect(s.push('1]')).toEqual([]); // "[a1]" is not a citation
  });
});
