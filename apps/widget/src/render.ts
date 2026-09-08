/**
 * Markdown → sanitized DOM with citation links.
 *
 *  1. snarkdown renders the (untrusted) model markdown to HTML.
 *  2. DOMPurify strips everything but a small tag allow-list. `a` and `img` are NOT allowed, so links the
 *     model writes become plain text and images disappear.
 *  3. `[n]` tokens in text nodes (outside code) are replaced with <a> elements built from `citation`
 *     events — the only source of links. Only https URLs are accepted, optionally restricted to the docs origin.
 */
import DOMPurify from 'dompurify';
import snarkdown from 'snarkdown';
import type { Citation } from './sse.js';

const ALLOWED_TAGS = ['p', 'br', 'strong', 'em', 'b', 'i', 'code', 'pre', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'sup', 'del'];
const ALLOWED_ATTR = ['class'];

export function isSafeCitationUrl(url: string, docsOrigin?: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  if (docsOrigin && u.origin !== docsOrigin) return false;
  return true;
}

export interface RenderOptions {
  citations: ReadonlyMap<number, Citation>;
  docsOrigin?: string;
  onCitationClick?: (c: Citation) => void;
  doc?: Document;
}

// snarkdown treats "[1]" as a reference-style link and eats the brackets, so citation markers are
// swapped for private-use placeholders before rendering and restored/linked in the text-node pass.
const OPEN = '\uE000';
const CLOSE = '\uE001';
const RAW_CITE_RE = /\[(\d{1,2})\]/g;
const CITE_RE = new RegExp(`${OPEN}(\\d{1,2})${CLOSE}`, 'g');

export function renderAnswer(markdown: string, opts: RenderOptions): DocumentFragment {
  const doc = opts.doc ?? document;
  const protectedMd = markdown.replace(/[\uE000\uE001]/g, '').replace(RAW_CITE_RE, `${OPEN}$1${CLOSE}`);
  const html = snarkdown(protectedMd);
  const purifier = DOMPurify(doc.defaultView ?? window);
  const purified = purifier.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    RETURN_DOM_FRAGMENT: true,
    KEEP_CONTENT: true,
  }) as DocumentFragment;
  // DOMPurify builds the fragment in its own inert document; adopt it so the tree walker and the
  // nodes we create below belong to the same document.
  const frag = doc.adoptNode(purified);

  const walker = doc.createTreeWalker(frag, 4 /* NodeFilter.SHOW_TEXT */);
  const textNodes: Text[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) textNodes.push(n as Text);

  for (const text of textNodes) {
    const value = text.data;
    if (insideCode(text)) {
      text.data = value.replace(CITE_RE, '[$1]');
      continue;
    }
    if (!CITE_RE.test(value)) {
      CITE_RE.lastIndex = 0;
      continue;
    }
    CITE_RE.lastIndex = 0;
    const replacement = doc.createDocumentFragment();
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = CITE_RE.exec(value))) {
      const num = Number(m[1]);
      const cit = opts.citations.get(num);
      const safe = cit && isSafeCitationUrl(cit.url, opts.docsOrigin);
      if (m.index > last) replacement.appendChild(doc.createTextNode(value.slice(last, m.index)));
      if (cit && safe) {
        const a = doc.createElement('a');
        a.className = 'cite';
        a.href = cit.url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.title = cit.title;
        a.setAttribute('part', 'citation');
        a.setAttribute('aria-label', `Source ${num}: ${cit.title}`);
        a.textContent = String(num);
        if (opts.onCitationClick) a.addEventListener('click', () => opts.onCitationClick!(cit));
        replacement.appendChild(a);
      } else {
        // no structured citation for this number (yet): keep the marker as text
        const sup = doc.createElement('sup');
        sup.className = 'cite-pending';
        sup.textContent = `[${num}]`;
        replacement.appendChild(sup);
      }
      last = m.index + m[0].length;
    }
    if (last < value.length) replacement.appendChild(doc.createTextNode(value.slice(last)));
    text.parentNode?.replaceChild(replacement, text);
  }
  return frag;
}

function insideCode(node: Node): boolean {
  let p = node.parentNode;
  while (p) {
    const name = (p as Element).nodeName;
    if (name === 'CODE' || name === 'PRE') return true;
    p = p.parentNode;
  }
  return false;
}
