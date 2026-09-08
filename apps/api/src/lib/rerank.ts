/**
 * Cross-encoder re-ranker. Default: local ONNX `Xenova/ms-marco-MiniLM-L-6-v2` via transformers.js
 * (no API key, ~23 MB quantized download on first run, cached under apps/api/.models).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Rerankable {
  id: string;
  text: string;
}

export interface Reranker {
  name: string;
  score(query: string, docs: Rerankable[]): Promise<number[]>; // higher is better, same order as docs
}

const MODEL_ID = 'Xenova/ms-marco-MiniLM-L-6-v2';
const modelsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.models');

let loading: Promise<Reranker> | undefined;

async function loadLocal(): Promise<Reranker> {
  const tf = await import('@huggingface/transformers');
  tf.env.cacheDir = modelsDir;
  const tokenizer = await tf.AutoTokenizer.from_pretrained(MODEL_ID);
  const model = await tf.AutoModelForSequenceClassification.from_pretrained(MODEL_ID, { dtype: 'q8' });
  return {
    name: MODEL_ID,
    async score(query, docs) {
      if (docs.length === 0) return [];
      const scores: number[] = [];
      // small batches keep peak memory low on long chunks
      const batch = 8;
      for (let i = 0; i < docs.length; i += batch) {
        const slice = docs.slice(i, i + batch);
        const inputs = tokenizer(
          slice.map(() => query),
          { text_pair: slice.map((d) => d.text), padding: true, truncation: true, max_length: 512 },
        );
        const out = (await model(inputs)) as { logits: { tolist(): number[][] } };
        for (const row of out.logits.tolist()) scores.push(row[0] ?? -Infinity);
      }
      return scores;
    },
  };
}

export function getReranker(): Promise<Reranker> {
  loading ??= loadLocal();
  return loading;
}

export async function rerank<T extends Rerankable>(
  query: string,
  docs: T[],
  keep: number,
): Promise<Array<T & { rerankScore: number }>> {
  const r = await getReranker();
  const scores = await r.score(query, docs);
  return docs
    .map((d, i) => ({ ...d, rerankScore: scores[i] ?? -Infinity }))
    .sort((a, b) => b.rerankScore - a.rerankScore)
    .slice(0, keep);
}
