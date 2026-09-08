import { gzipSync, brotliCompressSync } from 'node:zlib';
import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';

const LIMIT_KB = 30;
const require = createRequire(import.meta.url);
const kb = (n) => (n / 1024).toFixed(1);

function report(label, file) {
  const buf = readFileSync(file);
  const gz = gzipSync(buf, { level: 9 }).length;
  const br = brotliCompressSync(buf).length;
  console.log(`${label.padEnd(24)} raw ${kb(buf.length).padStart(6)} KB   gzip ${kb(gz).padStart(6)} KB   brotli ${kb(br).padStart(6)} KB`);
  return gz;
}

console.log('\nask-docs widget bundle');
const es = report('dist/ask-docs.js (esm)', 'dist/ask-docs.js');
const iife = report('dist/ask-docs.iife.js', 'dist/ask-docs.iife.js');

console.log('\nreference points (gzip of the vendor files as published):');
for (const [label, p] of [
  ['vue runtime-dom (esm prod)', 'vue/dist/vue.runtime.esm-browser.prod.js'],
  ['dompurify', 'dompurify/dist/purify.es.mjs'],
  ['snarkdown', 'snarkdown/dist/snarkdown.es.js'],
]) {
  try {
    const f = require.resolve(p);
    statSync(f);
    report(label, f);
  } catch {
    /* optional */
  }
}

const worst = Math.max(es, iife);
const status = worst <= LIMIT_KB * 1024 ? 'OK' : 'OVER TARGET';
console.log(`\nbundleKb (gzip, larger of esm/iife): ${kb(worst)}  target ≤ ${LIMIT_KB}  → ${status}\n`);
process.exitCode = 0; // report, never block the build; CI can grep for OVER TARGET
