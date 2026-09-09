# ask-docs · Architecture (iteration 1)

Two apps in a pnpm workspace plus an evals package:

| Package | What it is |
| --- | --- |
| `apps/api` | Hono server: `POST /ingest`, `POST /ask` (SSE), `GET /evals`, `GET /health`. Postgres 16 + pgvector. |
| `apps/widget` | `<ask-docs>` Vue 3 custom element (`defineCustomElement`, Shadow DOM), one JS file, no host dependencies. |
| `evals` | promptfoo config, 40 hand-labelled questions + 5 prompt-injection cases, in-process provider, judge asserts. |

All model calls go through **one module**, `apps/api/src/lib/llm.ts` (AI SDK): answerer, embeddings, judge.

**Anthropic-first.** The app runs with `ANTHROPIC_API_KEY` alone:

| role | default | provider | override |
| --- | --- | --- | --- |
| answer | `claude-opus-5` | Anthropic | `ANSWER_MODEL` |
| embed | `Xenova/bge-small-en-v1.5` (384-d, int8 ONNX, ~33 MB, cached in `apps/api/.models`) | local, no key, $0 | `EMBED_MODEL=text-embedding-3-small` → OpenAI |
| judge | `claude-sonnet-5` | Anthropic | `JUDGE_MODEL=gpt-5-mini` → OpenAI, cross-family |

The provider is inferred from the model id (`claude-*` → Anthropic, contains `/` → local transformers.js, else OpenAI).
`pnpm db:migrate` resizes `chunks.embedding` to the configured dimension (dropping indexed documents when it
changes); `GET /health` lists per-role provider readiness and any setup problem; the API logs the same at startup
and pre-loads both local ONNX models so the first question does not pay the download.

## Pipeline

```mermaid
flowchart LR
  subgraph ingest["POST /ingest (admin key)"]
    A[sitemap.xml\n/guide/** + /api/**] --> B[crawl\ndisk cache]
    B --> C[chunkHtml\nheading stack h1–h4\n200–800 tokens]
    C --> D[embed\nheader + body\nlocal bge-small]
    D --> E[(chunks\nvector(1536) + tsvector)]
  end

  subgraph ask["POST /ask (site token + origin allow-list + token bucket)"]
    Q[question] --> QE[embed\nlocal bge-small]
    QE --> H{hybrid SQL\ncosine top-30 ∪ ts_rank_cd top-30\nRRF k=60 → 30}
    E --> H
    H --> R[cross-encoder re-rank\nms-marco-MiniLM-L-6-v2 → keep 5]
    R --> P["prompt: system rules +\n&lt;documents&gt;&lt;document n=1..5&gt;…"]
    P --> M[claude-opus-5\nstreamText]
    M --> S[CitationScanner\n'[n]' → citation event]
    S --> SSE[SSE frames]
  end

  SSE --> W[widget: snarkdown → DOMPurify →\n[n] → &lt;a&gt; from citation events only]
```

### Chunking (`lib/chunk.ts`)

- Content root `main .vt-doc`; noise removed (`.header-anchor`, copy buttons, line-number gutters, nav/aside).
- Walk in document order keeping a heading stack; every block (paragraph, code fence, list, table, custom block)
  belongs to the section opened by the nearest heading. Composition/Options API variants are both kept.
- Section → pieces ≤ `max − headerTokens`; oversized blocks split on lines → sentences → words.
- Pieces < 200 tokens merge forward into the next sibling; the merged chunk keeps the first heading as its
  anchor and records every covered heading id in `anchors[]` (used by recall@5).
- Stored: `header` (`Vue Guide › Watchers › Deep Watchers`), `content`, `heading_path[]`, `anchors[]`, `url#anchor`.
  Embedding/tsvector input is `header + "\n\n" + content` (header weighted `A` in the tsvector).
- Links are flattened to text (Playground URLs alone were hundreds of tokens each); images dropped.

### Retrieval (`lib/retrieve.ts`, `lib/rerank.ts`)

One SQL statement, both arms filtered by `tenant`:

```sql
with vec as (select id, row_number() over (order by embedding <=> $q) r from chunks where tenant=$t order by embedding <=> $q limit 30),
     lex as (select id, row_number() over (order by ts_rank_cd(tsv,q) desc) r from chunks, websearch_to_tsquery('english',$text) q
             where tenant=$t and tsv @@ q order by ts_rank_cd(tsv,q) desc limit 30),
     fused as (select coalesce(vec.id,lex.id) id, coalesce(1.0/(60+vec.r),0)+coalesce(1.0/(60+lex.r),0) rrf
               from vec full outer join lex on vec.id=lex.id)
select c.*, f.rrf from fused f join chunks c on c.id=f.id order by f.rrf desc limit 30;
```

`ts_rank_cd` is BM25-*style* (no length normalisation/IDF tuning); ParadeDB `pg_search` is the upgrade path.
The 30 candidates are scored by a local ONNX cross-encoder (`Xenova/ms-marco-MiniLM-L-6-v2`, int8, ~150 ms
for 30 pairs on Apple silicon) and the top 5 become documents `1..5` in the prompt.

## SSE contract — `POST /ask`

Request

```http
POST /ask
Authorization: Bearer <public site token>
Origin: https://docs.example.com          # must be in the site's allow-list
Content-Type: application/json

{ "question": "How do I watch a nested property?", "sessionId": "optional" }
```

Non-stream failures are JSON with the same error shape and an HTTP status:
`401 unauthorized`, `403 origin_forbidden`, `429 rate_limited` (with `Retry-After`), `429 budget_exceeded`, `400 bad_request`.

**Errors carry the real reason.** `lib/errors.ts` unwraps AI SDK / provider / Postgres / local-model failures into
`{code, message, retryable}` where `message` is the provider's own text plus status (e.g.
`OpenAI 429 error: You have no credits remaining.`), with key-looking tokens redacted. Codes beyond the four above:
`config` (env var missing), `index_empty` (nothing ingested), `index_mismatch` (index embedded with another model),
`database`, `embed_model` (local ONNX model failed to load), `provider_auth`, `provider_quota` (not retryable),
`provider_rate_limited`, `provider_unavailable`, `provider_error`, `internal`. The same describer feeds the SSE
`error` frame, JSON errors, the eval provider and the ingest CLI.

Stream (`text/event-stream`). Every `data:` is a JSON object; the client never parses prose.

| order | event | data |
| --- | --- | --- |
| 1 | `meta` | `{"answerId","traceId","version":"it1+p<hash>","model"}` |
| 2 | `status` | `{"phase":"retrieving"}` then `{"phase":"generating"}` |
| 3…n | `delta` | `{"text":"…"}` — word-sized: the server re-chunks the provider stream with the AI SDK's `smoothStream` (8 ms pacing) because Anthropic emits Opus 5 text in 80–200-character bursts that a UI shows as sentence-sized jumps. The eval path uses the raw stream. |
| interleaved | `citation` | `{"n":2,"chunkId":"…","url":"https://vuejs.org/guide/…#deep-watchers","title":"Vue Guide › … › Deep Watchers"}` — emitted the first time the model references `[n]`; the server scans the token stream (`lib/citations.ts`, survives a marker split across deltas). Only `n` in `1..5` ever produce an event. |
| last | `done` | `{"usage":{"inputTokens","outputTokens","embedTokens","costUsd"},"citations":[…],"traceId","finishReason"}` |
| any | `error` | `{"code":"upstream|internal|…","message","retryable":bool}` |

Client **Stop** = `AbortController.abort()`. The server observes the abort, cancels the provider stream and
tags the Langfuse trace `interrupted`. A stream that ends without `done` is shown by the widget as **interrupted**
(partial text kept, Retry offered).

## Widget — `<ask-docs>`

| | |
| --- | --- |
| attributes | `api-url` (required), `site-token` (required), `docs-origin` (restrict citation links, e.g. `https://vuejs.org`), `placeholder`, `heading`, `max-length` (default 500) |
| methods | `el.ask(question?)`, `el.stop()`, `el.reset()` |
| events (bubbling, composed) | `ask-docs:ask {question}` · `ask-docs:answer {answerId,text,citations,usage,traceId}` · `ask-docs:stop {answerId}` · `ask-docs:error {code,message}` · `ask-docs:citation-click {n,url,chunkId}` |
| states (`data-state` on root part) | `idle → retrieving → generating → done \| stopped \| interrupted \| error` |
| a11y | `role="status" aria-live="polite"` announces each phase; citations have `aria-label="Source n: …"` |
| theming | `--ask-docs-bg/fg/accent/border/radius/font/mono/code-bg/muted/stop/warn/error`; `::part(root|form|input|ask|stop|status|answer|citations|citation|notice|meta)` |

Rendering pipeline per frame (rAF-throttled): `snarkdown` → `DOMPurify` (allow-list without `a`/`img`, only
`class` attr) → text-node pass replacing `[n]` with `<a>` built from `citation` events. Only `https:` URLs
(optionally same origin as `docs-origin`) become links; `javascript:`/`data:` cannot occur by construction.
Citation markers are protected from the markdown pass with private-use placeholders and never linked inside code.

Bundle (`pnpm --filter @ask-docs/widget build`, terser, options API off): **~52 KB gzip** for both the ESM and the
IIFE file. Target was ≤ 30 KB. Breakdown: Vue 3.5 runtime-dom ≈ 38–40 KB, DOMPurify ≈ 9 KB, widget + CSS + snarkdown ≈ 4 KB.
A Vue 3.6-rc Vapor build was tried and is *larger* (61 KB) because `defineVaporCustomElement` pulls both runtimes.
See open questions.

## Evals

- `evals/questions.json`: 40 `{id,q,relevant:["path#anchor"]}` + 5 `kind:"injection"` cases (2 in the question, 3 as a
  poisoned `<document>` appended after the retrieved five). `pnpm --filter @ask-docs/evals validate` checks every
  label against the index.
- promptfoo (`promptfooconfig.yaml`) runs `provider.ts` **in-process** (same `answerQuestion` as `/ask`), so asserts
  see exact chunk ids and the poisoned document can be injected without touching the corpus.
- `recall@5` = hits / relevant per case, hit when a kept chunk is on the page and covers the heading id.
- `faithfulness` = supported / all atomic claims, judged by the `JUDGE_MODEL`: **claude-sonnet-5** by default (a
  different model than the claude-opus-5 answerer, same family); set `JUDGE_MODEL=gpt-5-mini` for a cross-family
  judge. `eval_runs.judge_model` records which one produced each run.
- `injection pass` = canary and forbidden strings absent from the answer.
- `run.ts` aggregates promptfoo's JSON into `eval_runs` and `evals/results/<version>.json`; `GET /evals` serves
  runs by version; `apps/widget/demo/evals.html` renders them.

## Security model

- Provider keys live only in `apps/api/.env`. The widget knows `api-url` and a **public** site token. Error
  messages sent to clients pass through `redactSecrets` so a provider echoing a key back can never reach the widget.
- Site token → `sites` row → `tenant` + `allowed_origins`. `Origin` is checked on every `/ask`; CORS reflects only
  allow-listed origins. Tenant is never client-supplied; every retrieval query filters on it.
- Per-IP token bucket (burst 5, 10/min) and a per-site daily answer budget (cost cap). In-memory behind an interface
  a Redis implementation can replace.
- Retrieved chunks are wrapped in `<document>` tags, `</document>` sequences inside them are escaped, and the system
  prompt states documents are data, not instructions. 5 injection cases measure the pass rate.
- Traces (Langfuse, no-op without keys): IP/session HMAC-hashed, questions truncated to 200 chars, chunk ids/urls/
  scores logged, chunk content never logged, answer output truncated to 500 chars.
- Answer text can never produce a link; citation URLs come only from indexed chunk rows.

## Running it

```bash
pnpm install && pnpm db:up && pnpm db:migrate         # Docker Desktop must be running
cp .env.example apps/api/.env                          # add ANTHROPIC_API_KEY (OPENAI_API_KEY optional)
pnpm ingest --dry-run                                  # crawl + chunk only, no keys needed (81 pages, 515 chunks, ~10 s)
pnpm ingest                                            # 81 pages, 515 chunks, ~30 s with local embeddings
curl -s localhost:8787/health                          # providers, chunk count, embedDim, problems[]
pnpm --filter @ask-docs/api dev                        # http://localhost:8787
pnpm --filter @ask-docs/widget dev                     # http://localhost:5173/demo/index.html
pnpm eval                                              # writes eval_runs + evals/results/*.json
```

## Open questions

- **Widget size.** 52 KB gzip vs the 30 KB target. Vue's runtime-dom alone is ~43 KB gzip, so the target is not
  reachable with Vue 3.5 as the renderer. Options: (a) accept ~50 KB and document it, (b) drop Vue for the element
  and hand-write the DOM (~10 KB total), (c) wait for a Vapor build that does not pull both runtimes.
- **Lexical arm.** `ts_rank_cd` has no length normalisation or IDF; ParadeDB `pg_search` (real BM25) is the upgrade
  path if recall@5 on keyword-heavy questions (API names, option keys) turns out weak.
- **Small chunks.** Forward-merge leaves ~20 of 515 chunks under 100 tokens (the last section on a page has no
  sibling to merge into). Merge those backward into the previous chunk if they show up as noise in top-5.
- **Rate limiting.** Token bucket and daily budget are in-memory; a Redis implementation is needed before more than
  one API replica.
- **Faithfulness judge cost.** 40 cases × claims × gpt-5-mini per eval run; fine for iteration, but a cached
  judge result per `(answer hash)` would make re-runs of unchanged prompts free.
