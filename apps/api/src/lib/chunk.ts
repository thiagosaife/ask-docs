/**
 * Heading-path-aware chunking of a rendered docs page.
 *
 * HTML  →  sections (one per heading, with the full heading path)  →  chunks of 200–800 tokens.
 * Sections that are too small are merged forward into the next sibling (heading kept inline as text);
 * sections that are too large are split on block boundaries; the heading path is prepended to every
 * chunk when it is embedded/indexed (see `embedText`).
 */
import * as cheerio from 'cheerio';
import type { AnyNode, Element } from 'domhandler';
import TurndownService from 'turndown';
import { countTokens } from './tokens.js';

export interface ChunkInput {
  url: string; // canonical page url, no fragment
  html: string;
  sitePrefix?: string; // e.g. "Vue Guide"; derived from the URL when omitted
  minTokens?: number;
  maxTokens?: number;
}

export interface Chunk {
  ord: number;
  url: string; // page url + #anchor
  path: string; // 'guide/essentials/watchers'
  anchor: string | null;
  anchors: string[];
  headingPath: string[];
  header: string; // 'Vue Guide › Watchers › Deep Watchers'
  content: string;
  tokenCount: number;
}

export interface ChunkedDocument {
  url: string;
  path: string;
  title: string;
  chunks: Chunk[];
}

interface Section {
  headingPath: string[];
  anchors: string[];
  blocks: string[];
}

const HEADING = /^h[1-4]$/i;
const NOISE =
  'script, style, nav, aside, button, .header-anchor, .copy, span.lang, .line-numbers-wrapper, ' +
  '.vue-mastery-link, .VPDocAside, .edit-link, .prev-next, .lang-switch, .vt-doc-footer, .sponsors, .banner';

export function sitePrefixFor(url: string): string {
  const p = new URL(url).pathname;
  if (p.startsWith('/guide/')) return 'Vue Guide';
  if (p.startsWith('/api/')) return 'Vue API';
  if (p.startsWith('/examples/')) return 'Vue Examples';
  if (p.startsWith('/tutorial/')) return 'Vue Tutorial';
  if (p.startsWith('/style-guide/')) return 'Vue Style Guide';
  if (p.startsWith('/about/')) return 'Vue About';
  if (p.startsWith('/ecosystem/')) return 'Vue Ecosystem';
  return 'Vue Docs';
}

export function pathFor(url: string): string {
  return new URL(url).pathname.replace(/^\/+/, '').replace(/\.html$/, '').replace(/\/$/, '');
}

function makeTurndown(): TurndownService {
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '_',
  });
  // VitePress: <div class="language-ts"><pre><code>…</code></pre></div>
  td.addRule('vitepressCode', {
    filter: (node) => node.nodeName === 'PRE',
    replacement: (_content, node) => {
      const el = node as unknown as Element & { textContent: string; parentNode?: { getAttribute?: (n: string) => string | null } };
      const parentClass = el.parentNode?.getAttribute?.('class') ?? '';
      const lang = /language-([\w-]+)/.exec(parentClass)?.[1] ?? '';
      const text = (el.textContent ?? '').replace(/\n+$/, '');
      return `\n\n\`\`\`${lang}\n${text}\n\`\`\`\n\n`;
    },
  });
  // Links become plain text: hrefs (incl. giant play.vuejs.org state URLs) add tokens and no meaning,
  // and the answerer is told never to emit links anyway.
  td.addRule('linkText', {
    filter: 'a',
    replacement: (content) => content,
  });
  td.addRule('dropImages', { filter: 'img', replacement: () => '' });
  // minimal GFM tables
  td.addRule('table', {
    filter: 'table',
    replacement: (_content, node) => {
      const rows: string[][] = [];
      const table = node as unknown as { querySelectorAll: (s: string) => ArrayLike<{ querySelectorAll: (s: string) => ArrayLike<{ textContent: string | null }> }> };
      const trs = table.querySelectorAll('tr');
      for (let i = 0; i < trs.length; i++) {
        const cells = trs[i]!.querySelectorAll('th, td');
        const row: string[] = [];
        for (let j = 0; j < cells.length; j++) row.push((cells[j]!.textContent ?? '').replace(/\s+/g, ' ').trim());
        rows.push(row);
      }
      if (rows.length === 0) return '';
      const width = Math.max(...rows.map((r) => r.length));
      const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? '').join(' | ')} |`;
      const [head, ...body] = rows;
      return `\n\n${line(head!)}\n| ${Array.from({ length: width }, () => '---').join(' | ')} |\n${body.map(line).join('\n')}\n\n`;
    },
  });
  return td;
}

const turndown = makeTurndown();

function cleanText(md: string): string {
  return md
    .replace(/ /g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isCodeContainer($: cheerio.CheerioAPI, el: Element): boolean {
  const cls = $(el).attr('class') ?? '';
  return /(^|\s)language-/.test(cls) || $(el).children('pre').length > 0;
}

function isTransparentContainer($: cheerio.CheerioAPI, el: Element): boolean {
  if (el.tagName !== 'div' && el.tagName !== 'section' && el.tagName !== 'article') return false;
  if (isCodeContainer($, el)) return false;
  const cls = $(el).attr('class') ?? '';
  if (/custom-block|vp-code-group|vt-code-group/.test(cls)) return false; // keep as one block
  return true;
}

/** Split a block that is larger than the budget: by lines, then sentences, then words. */
function splitOversized(block: string, budget: number): string[] {
  const out: string[] = [];
  const pack = (units: string[], joiner: string, fallback?: (u: string) => string[]) => {
    let part: string[] = [];
    let partTokens = 0;
    const flush = () => {
      if (part.length) out.push(part.join(joiner));
      part = [];
      partTokens = 0;
    };
    for (const u of units) {
      const t = countTokens(u + joiner);
      if (t > budget && fallback) {
        flush();
        for (const sub of fallback(u)) out.push(sub);
        continue;
      }
      if (partTokens + t > budget) flush();
      part.push(u);
      partTokens += t;
    }
    flush();
  };
  const byWords = (s: string): string[] => {
    const res: string[] = [];
    let cur: string[] = [];
    let cnt = 0;
    for (const w of s.split(/\s+/)) {
      const t = countTokens(w + ' ');
      if (cnt + t > budget && cur.length) {
        res.push(cur.join(' '));
        cur = [];
        cnt = 0;
      }
      cur.push(w);
      cnt += t;
    }
    if (cur.length) res.push(cur.join(' '));
    return res;
  };
  const bySentences = (s: string): string[] => {
    const res: string[] = [];
    const sentences = s.split(/(?<=[.!?])\s+/);
    let cur: string[] = [];
    let cnt = 0;
    for (const sen of sentences) {
      const t = countTokens(sen + ' ');
      if (t > budget) {
        if (cur.length) res.push(cur.join(' '));
        cur = [];
        cnt = 0;
        res.push(...byWords(sen));
        continue;
      }
      if (cnt + t > budget && cur.length) {
        res.push(cur.join(' '));
        cur = [];
        cnt = 0;
      }
      cur.push(sen);
      cnt += t;
    }
    if (cur.length) res.push(cur.join(' '));
    return res;
  };
  pack(block.split('\n'), '\n', bySentences);
  return out.filter((p) => p.trim().length > 0);
}

export function chunkHtml(input: ChunkInput): ChunkedDocument {
  const minTokens = input.minTokens ?? 200;
  const maxTokens = input.maxTokens ?? 800;
  const $ = cheerio.load(input.html);
  $(NOISE).remove();

  const rootSel = ['main .vt-doc', 'main .vp-doc', '.vt-doc', '.vp-doc', 'main', 'article', 'body'];
  let root: cheerio.Cheerio<AnyNode> | undefined;
  for (const sel of rootSel) {
    const r = $(sel).first();
    if (r.length) {
      root = r;
      break;
    }
  }
  if (!root) throw new Error(`no content root in ${input.url}`);

  const title = cleanText($('h1').first().text()) || cleanText($('title').text()) || input.url;
  const sitePrefix = input.sitePrefix ?? sitePrefixFor(input.url);
  const pagePath = pathFor(input.url);

  // ---- walk in document order, building sections ----
  const sections: Section[] = [];
  const stack: Array<{ level: number; text: string; id: string }> = [];
  let current: Section = { headingPath: [title], anchors: [], blocks: [] };

  const startSection = () => {
    current = {
      headingPath: [title, ...stack.filter((h) => h.level > 1).map((h) => h.text)],
      anchors: stack.filter((h) => h.id && h.level > 1).map((h) => h.id),
      blocks: [],
    };
    sections.push(current);
  };
  sections.push(current);

  const visit = (el: Element) => {
    if (HEADING.test(el.tagName)) {
      const level = Number(el.tagName[1]);
      const text = cleanText($(el).text());
      const id = $(el).attr('id') ?? '';
      while (stack.length && stack[stack.length - 1]!.level >= level) stack.pop();
      stack.push({ level, text, id });
      startSection();
      return;
    }
    if (isTransparentContainer($, el)) {
      $(el)
        .children()
        .each((_, child) => visit(child as Element));
      return;
    }
    const html = $.html(el);
    const md = cleanText(turndown.turndown(html));
    if (md) current.blocks.push(md);
  };
  root.children().each((_, child) => visit(child as Element));

  // ---- size sections into chunks ----
  interface Piece {
    headingPath: string[];
    anchor: string | null; // deepest heading where this piece starts
    anchors: string[]; // every heading id covered (grows when small sections merge)
    blocks: string[];
    tokens: number;
  }
  const pieces: Piece[] = [];
  for (const s of sections) {
    if (s.blocks.length === 0) continue;
    // the heading path is prepended at embed time, so it must fit inside the window
    const headerTokens = countTokens([sitePrefix, ...s.headingPath].join(' › ') + '\n\n');
    const budget = Math.max(64, maxTokens - headerTokens);
    let buf: string[] = [];
    let bufTokens = 0;
    const flush = () => {
      if (buf.length) pieces.push({ headingPath: s.headingPath, anchor: s.anchors[s.anchors.length - 1] ?? null, anchors: s.anchors, blocks: buf, tokens: bufTokens });
      buf = [];
      bufTokens = 0;
    };
    for (const block of s.blocks) {
      const t = countTokens(block);
      if (t > budget) {
        flush();
        for (const part of splitOversized(block, budget)) {
          pieces.push({ headingPath: s.headingPath, anchor: s.anchors[s.anchors.length - 1] ?? null, anchors: s.anchors, blocks: [part], tokens: countTokens(part) });
        }
        continue;
      }
      if (bufTokens + t + 2 > budget) flush();
      buf.push(block);
      bufTokens += t + 2; // '\n\n' joiner
    }
    flush();
  }

  // merge small pieces forward
  const merged: Piece[] = [];
  for (const p of pieces) {
    const prev = merged[merged.length - 1];
    const headerTokens = countTokens([sitePrefix, ...prev?.headingPath ?? []].join(' › '));
    if (prev && prev.tokens < minTokens && prev.tokens + p.tokens + headerTokens + 8 <= maxTokens) {
      const sameHeading = prev.headingPath.join(' ') === p.headingPath.join(' ');
      const inlineHeading = sameHeading ? [] : [`${'#'.repeat(Math.min(6, p.headingPath.length + 1))} ${p.headingPath[p.headingPath.length - 1]}`];
      prev.blocks = [...prev.blocks, ...inlineHeading, ...p.blocks];
      prev.tokens = prev.tokens + p.tokens + (inlineHeading.length ? countTokens(inlineHeading[0]!) : 0);
      for (const a of p.anchors) if (!prev.anchors.includes(a)) prev.anchors.push(a);
      continue;
    }
    merged.push({ ...p, anchors: [...p.anchors], blocks: [...p.blocks] });
  }

  const chunks: Chunk[] = merged.map((p, i) => {
    const anchor = p.anchor;
    const headingPath = p.headingPath;
    const header = [sitePrefix, ...headingPath].join(' › ');
    const content = p.blocks.join('\n\n');
    return {
      ord: i,
      url: anchor ? `${input.url}#${anchor}` : input.url,
      path: pagePath,
      anchor,
      anchors: p.anchors,
      headingPath,
      header,
      content,
      tokenCount: countTokens(`${header}\n\n${content}`),
    };
  });

  return { url: input.url, path: pagePath, title, chunks };
}

/** What gets embedded and full-text indexed: heading path first, then the body. */
export function embedText(chunk: Pick<Chunk, 'header' | 'content'>): string {
  return `${chunk.header}\n\n${chunk.content}`;
}
