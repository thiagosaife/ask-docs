import { config } from './config.js';
import { PROMPT_HASH } from './prompt.js';

/** e.g. "it1+p3f9a1c": iteration tag + prompt hash, so eval runs stay comparable across prompt edits. */
export const VERSION = `${config.version}+p${PROMPT_HASH}`;
