import { getEncoding, type Tiktoken } from 'js-tiktoken';

let enc: Tiktoken | undefined;

/** o200k_base is a reasonable proxy for both Claude and OpenAI tokenizers for sizing chunks. */
export function countTokens(text: string): number {
  enc ??= getEncoding('o200k_base');
  return enc.encode(text).length;
}
