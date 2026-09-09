import { defineCustomElement } from 'vue';
import AskDocs from './AskDocs.ce.vue';

export const AskDocsElement = defineCustomElement(AskDocs);

export function register(tag = 'ask-docs'): void {
  if (typeof customElements !== 'undefined' && !customElements.get(tag)) customElements.define(tag, AskDocsElement);
}

register();

export type { AskEvent, Citation, AskUsage } from './sse.js';
