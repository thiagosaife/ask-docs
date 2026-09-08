import { describe, expect, it } from 'vitest';
import { chunkHtml, embedText, pathFor, sitePrefixFor } from '../src/lib/chunk.js';

const para = (n: number, seed = 'The reactive system tracks dependencies and re-renders when state changes. ') =>
  `<p>${seed.repeat(n)}</p>`;

const page = `
<html><head><title>Watchers | Vue.js</title></head><body>
<main><div class="vt-doc">
  <h1 id="watchers">Watchers <a class="header-anchor" href="#watchers">#</a></h1>
  ${para(8)}
  <h2 id="basic-example">Basic Example <a class="header-anchor" href="#basic-example">#</a></h2>
  <div class="options-api">${para(6, 'With the Options API, we can use the watch option to trigger a function whenever a reactive property changes. ')}</div>
  <div class="composition-api">${para(6, 'With Composition API, we can use the watch function to trigger a callback whenever a piece of reactive state changes. ')}
  <div class="language-js"><button class="copy"></button><span class="lang">js</span><pre><code>watch(question, async (newQuestion) => {
  if (newQuestion.includes('?')) {
    loading.value = true
  }
})</code></pre></div></div>
  <h3 id="watch-source-types">Watch Source Types <a class="header-anchor" href="#watch-source-types">#</a></h3>
  ${para(7, 'watch\'s first argument can be different types of reactive "sources": it can be a ref, a reactive object, a getter function, or an array of multiple sources. ')}
  <h2 id="deep-watchers">Deep Watchers <a class="header-anchor" href="#deep-watchers">#</a></h2>
  ${para(9, 'When you call watch() directly on a reactive object, it will implicitly create a deep watcher - the callback will be triggered on all nested mutations. ')}
  <div class="custom-block warning"><p class="custom-block-title">Use with Caution</p><p>Deep watch requires traversing all nested properties in the watched object, and can be expensive when used on large data structures.</p></div>
  <h2 id="tiny">Tiny Section <a class="header-anchor" href="#tiny">#</a></h2>
  <p>Short.</p>
  <h2 id="after-tiny">After Tiny <a class="header-anchor" href="#after-tiny">#</a></h2>
  ${para(8, 'Callback flush timing controls when the watcher callback fires relative to component updates. ')}
</div></main></body></html>`;

describe('chunkHtml', () => {
  const doc = chunkHtml({ url: 'https://vuejs.org/guide/essentials/watchers.html', html: page, minTokens: 60, maxTokens: 220 });

  it('derives title, path and site prefix', () => {
    expect(doc.title).toBe('Watchers');
    expect(doc.path).toBe('guide/essentials/watchers');
    expect(sitePrefixFor(doc.url)).toBe('Vue Guide');
    expect(pathFor('https://vuejs.org/api/reactivity-core.html')).toBe('api/reactivity-core');
  });

  it('prepends the full heading path to every chunk', () => {
    const deep = doc.chunks.find((c) => c.anchor === 'deep-watchers')!;
    expect(deep.header).toBe('Vue Guide › Watchers › Deep Watchers');
    expect(deep.headingPath).toEqual(['Watchers', 'Deep Watchers']);
    expect(embedText(deep).startsWith('Vue Guide › Watchers › Deep Watchers\n\n')).toBe(true);
    const h3 = doc.chunks.find((c) => c.anchor === 'watch-source-types')!;
    expect(h3.header).toBe('Vue Guide › Watchers › Basic Example › Watch Source Types');
    expect(h3.anchors).toEqual(['basic-example', 'watch-source-types']);
  });

  it('keeps chunks inside the token window and merges tiny sections forward', () => {
    for (const c of doc.chunks) expect(c.tokenCount).toBeLessThanOrEqual(220);
    const tiny = doc.chunks.find((c) => c.anchors.includes('tiny'))!;
    expect(tiny.anchors).toContain('after-tiny');
    expect(tiny.content).toContain('## After Tiny');
    expect(tiny.url).toBe('https://vuejs.org/guide/essentials/watchers.html#tiny');
  });

  it('strips anchors/copy buttons and keeps code fences with language', () => {
    const basic = doc.chunks.find((c) => c.anchor === 'basic-example' && c.content.includes('```js'))!;
    expect(basic.content).toContain('```js\nwatch(question');
    expect(basic.content).not.toContain('#');
    expect(basic.content).not.toContain('copy');
  });

  it('produces contiguous ords and page-level chunks for the h1 intro', () => {
    expect(doc.chunks.map((c) => c.ord)).toEqual(doc.chunks.map((_, i) => i));
    expect(doc.chunks[0]!.anchor).toBeNull();
    expect(doc.chunks[0]!.url).toBe('https://vuejs.org/guide/essentials/watchers.html');
  });

  it('splits an oversized code block on line boundaries', () => {
    const big = `<html><body><main><div class="vt-doc"><h1 id="x">X</h1><div class="language-ts"><pre><code>${'const line = 1\n'.repeat(400)}</code></pre></div></div></main></body></html>`;
    const d = chunkHtml({ url: 'https://vuejs.org/api/x.html', html: big, minTokens: 50, maxTokens: 300 });
    expect(d.chunks.length).toBeGreaterThan(3);
    for (const c of d.chunks) expect(c.tokenCount).toBeLessThanOrEqual(300);
  });
});
