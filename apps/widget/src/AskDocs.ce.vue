<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';
import { askStream, type AskEvent, type AskUsage, type Citation } from './sse.js';
import { renderAnswer } from './render.js';

type State = 'idle' | 'retrieving' | 'generating' | 'done' | 'stopped' | 'interrupted' | 'error';

const props = withDefaults(
  defineProps<{
    apiUrl: string;
    siteToken: string;
    placeholder?: string;
    heading?: string;
    maxLength?: number | string;
    /** restrict citation links to this origin, e.g. https://vuejs.org */
    docsOrigin?: string;
  }>(),
  { placeholder: 'Ask the docs…', heading: 'Ask the docs', maxLength: 500, docsOrigin: '' },
);

const root = ref<HTMLElement>();
const answerEl = ref<HTMLElement>();
const inputEl = ref<HTMLTextAreaElement>();

const question = ref('');
const state = ref<State>('idle');
const errorMessage = ref('');
const errorRetryable = ref(false);
const answerText = ref('');
const citations = shallowRef<Map<number, Citation>>(new Map());
const usedCitations = ref<Citation[]>([]);
const usage = ref<AskUsage | null>(null);
const answerId = ref('');
const traceId = ref('');
let controller: AbortController | null = null;
let raf = 0;
const sessionId = Math.random().toString(36).slice(2, 12);

const maxLen = computed(() => Number(props.maxLength) || 500);
const busy = computed(() => state.value === 'retrieving' || state.value === 'generating');
const statusText = computed(() => {
  switch (state.value) {
    case 'retrieving':
      return 'Searching the docs…';
    case 'generating':
      return 'Writing the answer…';
    case 'done':
      return 'Answer complete.';
    case 'stopped':
      return 'Stopped.';
    case 'interrupted':
      return 'Connection interrupted. The answer may be incomplete.';
    case 'error':
      return `Error: ${errorMessage.value}`;
    default:
      return '';
  }
});

function host(): HTMLElement | null {
  const r = root.value?.getRootNode();
  return r && 'host' in r ? ((r as ShadowRoot).host as HTMLElement) : null;
}
function dispatch(name: string, detail: unknown) {
  host()?.dispatchEvent(new CustomEvent(`ask-docs:${name}`, { detail, bubbles: true, composed: true }));
}

function scheduleRender() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    paint();
  });
}
function paint() {
  const el = answerEl.value;
  if (!el) return;
  const frag = renderAnswer(answerText.value, {
    citations: citations.value,
    ...(props.docsOrigin ? { docsOrigin: props.docsOrigin } : {}),
    onCitationClick: (c) => dispatch('citation-click', { n: c.n, url: c.url, chunkId: c.chunkId }),
    doc: el.ownerDocument,
  });
  el.replaceChildren(frag);
}

function handleEvent(e: AskEvent) {
  switch (e.event) {
    case 'meta':
      answerId.value = e.data.answerId;
      traceId.value = e.data.traceId;
      break;
    case 'status':
      state.value = e.data.phase;
      break;
    case 'delta':
      answerText.value += e.data.text;
      scheduleRender();
      break;
    case 'citation': {
      const next = new Map(citations.value);
      next.set(e.data.n, e.data);
      citations.value = next;
      usedCitations.value = [...next.values()].sort((a, b) => a.n - b.n);
      scheduleRender();
      break;
    }
    case 'done':
      usage.value = e.data.usage;
      usedCitations.value = e.data.citations;
      break;
    case 'error':
      errorMessage.value = e.data.message;
      errorRetryable.value = e.data.retryable;
      break;
  }
}

async function ask(q?: string) {
  const text = (q ?? question.value).trim().slice(0, maxLen.value);
  if (!text || busy.value) return;
  if (q !== undefined) question.value = text;
  stop();
  answerText.value = '';
  citations.value = new Map();
  usedCitations.value = [];
  usage.value = null;
  errorMessage.value = '';
  state.value = 'retrieving';
  paint();
  dispatch('ask', { question: text });

  controller = new AbortController();
  const ac = controller;
  const outcome = await askStream({
    apiUrl: props.apiUrl,
    siteToken: props.siteToken,
    question: text,
    sessionId,
    signal: ac.signal,
    onEvent: handleEvent,
  });
  if (ac !== controller) return; // superseded by a newer ask()
  controller = null;
  if (raf) {
    cancelAnimationFrame(raf);
    raf = 0;
  }
  paint();
  switch (outcome) {
    case 'done':
      state.value = 'done';
      dispatch('answer', { answerId: answerId.value, text: answerText.value, citations: usedCitations.value, usage: usage.value, traceId: traceId.value });
      break;
    case 'aborted':
      state.value = 'stopped';
      dispatch('stop', { answerId: answerId.value });
      break;
    case 'interrupted':
      state.value = 'interrupted';
      dispatch('error', { code: 'interrupted', message: 'connection interrupted' });
      break;
    case 'error':
      state.value = 'error';
      dispatch('error', { code: 'error', message: errorMessage.value });
      break;
  }
}

function stop() {
  if (controller) {
    controller.abort();
    controller = null;
  }
}

function reset() {
  stop();
  question.value = '';
  answerText.value = '';
  citations.value = new Map();
  usedCitations.value = [];
  usage.value = null;
  errorMessage.value = '';
  state.value = 'idle';
  paint();
  inputEl.value?.focus();
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    void ask();
  }
}

onMounted(() => paint());
onBeforeUnmount(() => stop());

defineExpose({ ask, stop, reset });
</script>

<template>
  <section ref="root" class="ask-docs" part="root" :data-state="state">
    <form class="ask" part="form" @submit.prevent="ask()">
      <label class="sr-only" for="q">{{ heading }}</label>
      <textarea
        id="q"
        ref="inputEl"
        v-model="question"
        part="input"
        class="input"
        rows="1"
        :placeholder="placeholder"
        :maxlength="maxLen"
        :disabled="busy"
        autocomplete="off"
        @keydown="onKeydown"
      />
      <button v-if="busy" type="button" part="stop" class="btn stop" @click="stop()">Stop</button>
      <button v-else type="submit" part="ask" class="btn" :disabled="!question.trim()">Ask</button>
    </form>

    <p class="status" part="status" role="status" aria-live="polite" aria-atomic="true">
      <span v-if="busy" class="spinner" aria-hidden="true"></span>{{ statusText }}
    </p>

    <div v-show="answerText || state === 'error'" class="panel" part="answer-panel">
      <div ref="answerEl" class="answer" part="answer" aria-label="Answer"></div>
      <p v-if="state === 'interrupted'" class="notice warn" part="notice">
        Interrupted — the connection dropped before the answer finished.
        <button type="button" class="link" @click="ask(question)">Retry</button>
      </p>
      <p v-else-if="state === 'stopped'" class="notice" part="notice">Stopped.</p>
      <p v-else-if="state === 'error'" class="notice error" part="notice">
        {{ errorMessage || 'Something went wrong.' }}
        <button v-if="errorRetryable" type="button" class="link" @click="ask(question)">Retry</button>
      </p>
      <ol v-if="usedCitations.length" class="sources" part="citations" aria-label="Sources">
        <li v-for="c in usedCitations" :key="c.n">
          <a :href="c.url" target="_blank" rel="noopener noreferrer" @click="dispatch('citation-click', { n: c.n, url: c.url, chunkId: c.chunkId })">
            <span class="n">{{ c.n }}</span> {{ c.title }}
          </a>
        </li>
      </ol>
      <p v-if="usage" class="meta" part="meta">{{ usage.inputTokens + usage.outputTokens }} tokens · ${{ usage.costUsd.toFixed(4) }}</p>
    </div>
  </section>
</template>

<style>
:host {
  display: block;
  box-sizing: border-box;
  font: var(--ask-docs-font, 15px/1.5 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif);
  color: var(--ask-docs-fg, #1a1a1a);
  color-scheme: light dark;
}
*,
*::before,
*::after {
  box-sizing: inherit;
}
.ask-docs {
  background: var(--ask-docs-bg, #fff);
  border: 1px solid var(--ask-docs-border, #d9d9d9);
  border-radius: var(--ask-docs-radius, 12px);
  padding: 12px;
  max-width: 100%;
}
.ask {
  display: flex;
  gap: 8px;
  align-items: flex-end;
}
.input {
  flex: 1;
  min-height: 40px;
  max-height: 160px;
  resize: vertical;
  padding: 8px 10px;
  font: inherit;
  color: inherit;
  background: var(--ask-docs-input-bg, transparent);
  border: 1px solid var(--ask-docs-border, #d9d9d9);
  border-radius: calc(var(--ask-docs-radius, 12px) - 4px);
}
.input:focus {
  outline: 2px solid var(--ask-docs-accent, #42b883);
  outline-offset: 1px;
}
.btn {
  font: inherit;
  font-weight: 600;
  padding: 8px 14px;
  min-height: 40px;
  color: #fff;
  background: var(--ask-docs-accent, #42b883);
  border: 0;
  border-radius: calc(var(--ask-docs-radius, 12px) - 4px);
  cursor: pointer;
}
.btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.btn.stop {
  background: var(--ask-docs-stop, #b54a4a);
}
.link {
  font: inherit;
  color: var(--ask-docs-accent, #42b883);
  background: none;
  border: 0;
  padding: 0;
  text-decoration: underline;
  cursor: pointer;
}
.status {
  margin: 8px 2px 0;
  min-height: 1.4em;
  font-size: 0.9em;
  color: var(--ask-docs-muted, #666);
  display: flex;
  gap: 8px;
  align-items: center;
}
.spinner {
  width: 12px;
  height: 12px;
  border: 2px solid var(--ask-docs-accent, #42b883);
  border-right-color: transparent;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
.panel {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--ask-docs-border, #d9d9d9);
}
.answer {
  overflow-wrap: anywhere;
}
.answer > :first-child {
  margin-top: 0;
}
.answer pre {
  overflow-x: auto;
  padding: 10px 12px;
  background: var(--ask-docs-code-bg, #f4f4f5);
  border-radius: 8px;
  font-size: 0.9em;
}
.answer code {
  font-family: var(--ask-docs-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 0.92em;
}
.answer :not(pre) > code {
  background: var(--ask-docs-code-bg, #f4f4f5);
  padding: 0.1em 0.35em;
  border-radius: 4px;
}
.answer a.cite,
.sources .n {
  display: inline-block;
  min-width: 1.5em;
  padding: 0 0.35em;
  margin: 0 0.1em;
  font-size: 0.75em;
  line-height: 1.6;
  text-align: center;
  color: #fff;
  background: var(--ask-docs-accent, #42b883);
  border-radius: 999px;
  text-decoration: none;
  vertical-align: 0.2em;
}
.answer sup.cite-pending {
  color: var(--ask-docs-muted, #666);
  font-size: 0.75em;
}
.sources {
  margin: 10px 0 0;
  padding: 0;
  list-style: none;
  font-size: 0.88em;
}
.sources li {
  margin: 4px 0;
}
.sources a {
  color: inherit;
  text-decoration: none;
}
.sources a:hover {
  text-decoration: underline;
}
.notice {
  margin: 8px 0 0;
  font-size: 0.9em;
  color: var(--ask-docs-muted, #666);
}
.notice.warn {
  color: var(--ask-docs-warn, #9a6700);
}
.notice.error {
  color: var(--ask-docs-error, #b54a4a);
}
.meta {
  margin: 8px 0 0;
  font-size: 0.75em;
  color: var(--ask-docs-muted, #666);
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
@media (prefers-color-scheme: dark) {
  :host {
    color: var(--ask-docs-fg, #e6e6e6);
  }
  .ask-docs {
    background: var(--ask-docs-bg, #1b1b1f);
    border-color: var(--ask-docs-border, #3a3a40);
  }
  .input,
  .panel {
    border-color: var(--ask-docs-border, #3a3a40);
  }
  .answer pre,
  .answer :not(pre) > code {
    background: var(--ask-docs-code-bg, #26262b);
  }
  .status,
  .notice,
  .meta {
    color: var(--ask-docs-muted, #9a9aa3);
  }
}
</style>
