# ask-docs

Ask questions about a documentation site and get a streamed, cited answer. Ships as an embeddable
`<ask-docs>` web component backed by a small retrieval API. The demo indexes the [Vue.js docs](https://vuejs.org).

```html
<script type="module" src="https://cdn.example.com/ask-docs.js"></script>
<ask-docs api-url="https://ask.example.com" site-token="pk_demo_vuejs" docs-origin="https://vuejs.org"></ask-docs>
```

Answers stream word by word; every `[n]` in the text becomes a link to the exact section it came from.
The widget never sees a provider key, only a public site token tied to an origin allow-list.

## How it works

1. **Ingest** crawls the site's sitemap, chunks each page by heading (200–800 tokens), embeds the chunks with a
   local ONNX model and stores them in Postgres + pgvector.
2. **Ask** embeds the question, runs hybrid retrieval (cosine + full-text, fused with reciprocal rank fusion),
   re-ranks the top 30 with a local cross-encoder and hands the best 5 to `claude-opus-5` as numbered documents.
3. The answer is streamed over SSE. The server scans the token stream for `[n]` and emits a `citation` event with
   the chunk's URL the first time each one appears, so links come from the index, never from model output.
4. **Evals** replay 40 hand-labelled questions plus 5 prompt-injection cases through the same code path and report
   recall@5, claim-level faithfulness and injection pass rate per prompt version.

Full design, the SSE contract, the security model and open questions: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Layout

| Package | What it is |
| --- | --- |
| [`apps/api`](apps/api) | Hono server: `POST /ingest`, `POST /ask` (SSE), `GET /evals`, `GET /health`. Postgres 16 + pgvector. |
| [`apps/widget`](apps/widget) | `<ask-docs>` Vue 3 custom element (Shadow DOM), one JS file, no host dependencies. |
| [`evals`](evals) | promptfoo config, labelled questions, in-process provider, judge asserts, runner. |

## Requirements

- Node 22+ and pnpm 12 (`corepack enable` picks the pinned version)
- Docker Desktop (for Postgres)
- An Anthropic API key. That is the only key needed: embeddings and re-ranking run locally, and the eval judge
  defaults to `claude-sonnet-5`. An OpenAI key is optional (see [Models](#models)).

## Quick start

```bash
pnpm install
pnpm db:up && pnpm db:migrate        # Postgres on :5433, schema + demo site
cp .env.example apps/api/.env        # then set ANTHROPIC_API_KEY
pnpm ingest                          # crawl + chunk + embed vuejs.org (81 pages, ~30 s)
pnpm --filter @ask-docs/api dev      # http://localhost:8787
pnpm --filter @ask-docs/widget dev   # http://localhost:5173/demo/index.html
```

Check the API before opening the browser. `problems` must be empty:

```bash
curl -s localhost:8787/health
```

Ask a question from the terminal:

```bash
curl -N localhost:8787/ask \
  -H "Authorization: Bearer pk_demo_vuejs" \
  -H "Origin: http://localhost:5173" \
  -H "Content-Type: application/json" \
  -d '{"question":"How do I watch a nested property?"}'
```

Other commands:

```bash
pnpm ingest --dry-run                       # crawl + chunk only, no keys, prints token stats
pnpm --filter @ask-docs/evals validate      # every labelled section still exists in the index
pnpm eval                                   # ~45 model calls, writes eval_runs + evals/results/<version>.json
pnpm test && pnpm typecheck                 # unit tests (api + widget) and TypeScript
pnpm --filter @ask-docs/widget build        # dist/ask-docs.js (+ .iife.js) with a gzip size report
```

Eval results render at `http://localhost:5173/demo/evals.html`.

## Models

Every model call goes through one module, `apps/api/src/lib/llm.ts`. The provider is inferred from the model id.

| Role | Default | Provider | Env override |
| --- | --- | --- | --- |
| answer | `claude-opus-5` | Anthropic | `ANSWER_MODEL` |
| embed | `Xenova/bge-small-en-v1.5` (384-d, int8 ONNX, ~33 MB, cached in `apps/api/.models`) | local, no key | `EMBED_MODEL=text-embedding-3-small` for OpenAI |
| judge | `claude-sonnet-5` | Anthropic | `JUDGE_MODEL=gpt-5-mini` for a cross-family judge |

Changing `EMBED_MODEL` changes the vector dimension: run `pnpm db:migrate` (it resizes the column and drops the
index) and then `pnpm ingest` again.

## Errors carry the real reason

Every failure reaches the client as `{code, message, retryable}` where `message` is the provider's own text, for
example `Anthropic 400 error: Your credit balance is too low to access the Anthropic API.` Codes cover missing
keys (`config`), an empty or stale index (`index_empty`, `index_mismatch`), the database, local model loading,
and provider auth / quota / rate-limit / outage. The widget shows the message as-is and offers Retry when it makes
sense. Key-looking tokens are redacted before anything leaves the server.

## Baseline (iteration 1)

| version `it1+pa1ca8e` | |
| --- | --- |
| recall@5 | 0.89 |
| faithfulness | 1.00 |
| injection pass rate | 1.00 |
| cost per answer | $0.028 |
| widget bundle | 52 KB gzip (target 30, see open questions) |

## Widget API

| | |
| --- | --- |
| attributes | `api-url`, `site-token` (required); `docs-origin`, `placeholder`, `heading`, `max-length` |
| methods | `el.ask(question?)`, `el.stop()`, `el.reset()` |
| events | `ask-docs:ask`, `ask-docs:answer`, `ask-docs:stop`, `ask-docs:error`, `ask-docs:citation-click` |
| theming | `--ask-docs-bg/fg/accent/border/radius/font/mono/code-bg/muted/stop/warn/error` and `::part(...)` |

See `apps/widget/demo/` for a plain-HTML host page and a re-themed instance.
