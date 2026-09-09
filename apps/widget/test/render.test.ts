import { describe, expect, it, vi } from 'vitest';
import { isSafeCitationUrl, renderAnswer } from '../src/render.js';
import type { Citation } from '../src/sse.js';

const cit = (n: number, url: string): Citation => ({ n, chunkId: `c${n}`, url, title: `Doc ${n}` });
const html = (md: string, cits: Citation[] = [], docsOrigin?: string) => {
  const div = document.createElement('div');
  div.appendChild(renderAnswer(md, { citations: new Map(cits.map((c) => [c.n, c])), ...(docsOrigin ? { docsOrigin } : {}) }));
  return div;
};

describe('renderAnswer', () => {
  it('turns [n] into links only when a structured citation exists', () => {
    const el = html('Use `ref()` for primitives [1]. Deep watchers traverse everything [2].', [cit(1, 'https://vuejs.org/guide/essentials/reactivity-fundamentals.html#ref')]);
    const links = el.querySelectorAll('a');
    expect(links).toHaveLength(1);
    expect(links[0]!.getAttribute('href')).toBe('https://vuejs.org/guide/essentials/reactivity-fundamentals.html#ref');
    expect(links[0]!.getAttribute('rel')).toBe('noopener noreferrer');
    expect(links[0]!.textContent).toBe('1');
    expect(el.querySelector('sup.cite-pending')!.textContent).toBe('[2]');
  });

  it('never creates links from model text (markdown links, raw html, images)', () => {
    const el = html('See [the guide](https://evil.example.com/x) and <a href="javascript:alert(1)">click</a> <img src=x onerror=alert(1)> done.');
    expect(el.querySelectorAll('a')).toHaveLength(0);
    expect(el.querySelectorAll('img')).toHaveLength(0);
    expect(el.innerHTML).not.toContain('javascript:');
    expect(el.innerHTML).not.toContain('onerror');
    expect(el.textContent).toContain('the guide');
  });

  it('rejects javascript:, data: and non-https citation urls, and enforces the docs origin', () => {
    expect(isSafeCitationUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeCitationUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
    expect(isSafeCitationUrl('http://vuejs.org/guide')).toBe(false);
    expect(isSafeCitationUrl('https://vuejs.org/guide')).toBe(true);
    expect(isSafeCitationUrl('https://evil.example.com/guide', 'https://vuejs.org')).toBe(false);
    const el = html('Bad [1] and worse [2] and ok [3].', [
      cit(1, 'javascript:alert(1)'),
      cit(2, 'data:text/html,hi'),
      cit(3, 'https://vuejs.org/api/reactivity-core.html#watch'),
    ]);
    const links = el.querySelectorAll('a');
    expect(links).toHaveLength(1);
    expect(links[0]!.getAttribute('href')).toBe('https://vuejs.org/api/reactivity-core.html#watch');
  });

  it('does not touch brackets inside code', () => {
    const el = html('Index with `arr[1]`:\n\n```js\nconst x = list[1]\n```\n\nSee [1].', [cit(1, 'https://vuejs.org/a')]);
    expect(el.querySelectorAll('a')).toHaveLength(1);
    expect(el.querySelector('code')!.textContent).toContain('arr[1]');
    expect(el.querySelector('pre')!.textContent).toContain('list[1]');
  });

  it('strips disallowed tags but keeps their content, and strips attributes', () => {
    const el = html('<script>alert(1)</script><p style="color:red" onclick="x()">hello <b>bold</b></p><iframe src="x"></iframe>');
    expect(el.querySelector('script')).toBeNull();
    expect(el.querySelector('iframe')).toBeNull();
    expect(el.querySelector('p')!.getAttribute('style')).toBeNull();
    expect(el.querySelector('p')!.getAttribute('onclick')).toBeNull();
    expect(el.textContent).toContain('hello bold');
  });

  it('fires the click callback with the citation', () => {
    const onCitationClick = vi.fn();
    const div = document.createElement('div');
    const c = cit(1, 'https://vuejs.org/x');
    div.appendChild(renderAnswer('x [1]', { citations: new Map([[1, c]]), onCitationClick }));
    div.querySelector('a')!.dispatchEvent(new MouseEvent('click'));
    expect(onCitationClick).toHaveBeenCalledWith(c);
  });
});
