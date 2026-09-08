/**
 * Streaming scanner for `[n]` citation markers in model output.
 *
 * The model writes `[2]` in prose; the server (not the widget) turns the first sighting of each
 * number into a structured `citation` event. Markers can be split across deltas ("[" in one chunk,
 * "2]" in the next), so the scanner keeps a small tail buffer between pushes.
 */
export class CitationScanner {
  private tail = '';
  private readonly seen = new Set<number>();

  constructor(private readonly valid: (n: number) => boolean) {}

  /** Feed a delta; returns the citation numbers newly referenced by this delta (in order). */
  push(delta: string): number[] {
    const text = this.tail + delta;
    const found: number[] = [];
    const re = /\[(\d{1,2})\]/g;
    let m: RegExpExecArray | null;
    let lastEnd = 0;
    while ((m = re.exec(text))) {
      lastEnd = m.index + m[0].length;
      const n = Number(m[1]);
      if (this.valid(n) && !this.seen.has(n)) {
        this.seen.add(n);
        found.push(n);
      }
    }
    // keep any trailing partial marker like "[" or "[1" for the next push
    const rest = text.slice(lastEnd);
    const partial = /\[\d{0,2}$/.exec(rest);
    this.tail = partial ? partial[0] : '';
    return found;
  }

  get referenced(): number[] {
    return [...this.seen].sort((a, b) => a - b);
  }
}
