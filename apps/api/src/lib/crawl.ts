/**
 * Polite crawler for a docs site. Discovers pages from sitemap.xml (falls back to same-origin BFS),
 * caches raw HTML on disk so re-ingests do not re-fetch, and limits concurrency.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as cheerio from 'cheerio';

export interface CrawlOptions {
  baseUrl: string; // https://vuejs.org
  include: RegExp[]; // path prefixes to keep, e.g. /^\/guide\//
  exclude?: RegExp[];
  cacheDir: string;
  concurrency?: number;
  delayMs?: number;
  maxPages?: number;
  useCache?: boolean;
  log?: (msg: string) => void;
}

export interface CrawledPage {
  url: string;
  html: string;
  fromCache: boolean;
}

export function canonicalize(raw: string, base: string): string | null {
  let u: URL;
  try {
    u = new URL(raw, base);
  } catch {
    return null;
  }
  if (u.origin !== new URL(base).origin) return null;
  u.hash = '';
  u.search = '';
  if (u.pathname.endsWith('/index.html')) u.pathname = u.pathname.slice(0, -'index.html'.length);
  return u.toString();
}

function cachePath(dir: string, url: string): string {
  return path.join(dir, createHash('sha1').update(url).digest('hex') + '.html');
}

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'user-agent': 'ask-docs-ingest/0.1 (+https://github.com/ask-docs)', accept: 'text/html' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  const ct = res.headers.get('content-type') ?? '';
  if (!ct.includes('text/html')) throw new Error(`GET ${url} → not html (${ct})`);
  return await res.text();
}

export async function discoverFromSitemap(baseUrl: string): Promise<string[]> {
  const res = await fetch(new URL('/sitemap.xml', baseUrl));
  if (!res.ok) return [];
  const xml = await res.text();
  const $ = cheerio.load(xml, { xml: true });
  const urls: string[] = [];
  $('url > loc').each((_, el) => {
    urls.push($(el).text().trim());
  });
  return urls;
}

export async function crawl(opts: CrawlOptions): Promise<CrawledPage[]> {
  const log = opts.log ?? (() => {});
  const concurrency = opts.concurrency ?? 4;
  const delayMs = opts.delayMs ?? 150;
  const useCache = opts.useCache ?? true;
  await mkdir(opts.cacheDir, { recursive: true });

  const keep = (url: string) => {
    const p = new URL(url).pathname;
    return opts.include.some((r) => r.test(p)) && !(opts.exclude ?? []).some((r) => r.test(p));
  };

  const seen = new Set<string>();
  const queue: string[] = [];
  const results: CrawledPage[] = [];

  const sitemap = (await discoverFromSitemap(opts.baseUrl))
    .map((u) => canonicalize(u, opts.baseUrl))
    .filter((u): u is string => !!u && keep(u));
  const bfs = sitemap.length === 0;
  if (bfs) {
    log('no sitemap; falling back to BFS');
    for (const r of opts.include) {
      // seed from the first matching prefix's index page
      const seed = r.source.replace(/^\^/, '').replace(/\\\//g, '/').replace(/[^\w/.-].*$/, '');
      const u = canonicalize(seed, opts.baseUrl);
      if (u) queue.push(u);
    }
  } else {
    log(`sitemap: ${sitemap.length} matching urls`);
    queue.push(...sitemap);
  }

  const worker = async () => {
    while (queue.length) {
      if (opts.maxPages && results.length >= opts.maxPages) return;
      const url = queue.shift()!;
      if (seen.has(url)) continue;
      seen.add(url);
      const cp = cachePath(opts.cacheDir, url);
      let html: string | undefined;
      let fromCache = false;
      if (useCache) {
        try {
          html = await readFile(cp, 'utf8');
          fromCache = true;
        } catch {
          /* miss */
        }
      }
      if (html === undefined) {
        try {
          html = await fetchHtml(url);
          await writeFile(cp, html);
          await new Promise((r) => setTimeout(r, delayMs));
        } catch (e) {
          log(`skip ${url}: ${(e as Error).message}`);
          continue;
        }
      }
      results.push({ url, html, fromCache });
      if (bfs) {
        const $ = cheerio.load(html);
        $('a[href]').each((_, a) => {
          const u = canonicalize($(a).attr('href') ?? '', opts.baseUrl);
          if (u && keep(u) && !seen.has(u)) queue.push(u);
        });
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  results.sort((a, b) => a.url.localeCompare(b.url));
  return results;
}
