import { Feature } from "../profile.ts";
import type { ResolvedTokenEstimationOptions } from "../segments.ts";
import { countTextTokens } from "../segments.ts";
import type { ImageGeometry } from "./images.ts";

/**
 * The state of one walk. The walker only counts features into `tally`; the
 * estimate is the dot product of the tally and the profile weights.
 */
export interface WalkContext {
  tally: Float64Array;
  weights: Float64Array;
  text: ResolvedTokenEstimationOptions;
  images: ImageGeometry;
  /** Token estimates of whole strings, when caching is enabled. */
  textCache?: Map<string, number>;
  /** Internal extraction hook that supplies the count without rescanning text. */
  onText?: (text: string) => number;
  /** Set while walking a message before the last user message. */
  priorTurn?: boolean;
  /** Encrypted reasoning, and stored OpenAI items, already charged in this request. */
  sentReasoning?: Set<string>;
  /** Stored OpenAI reasoning items of the current message that have summary text. */
  summarizedItems?: Set<string>;
}

/** Adds the estimated tokens of a text to the text slot, or to another slot. */
export function addText(
  context: WalkContext,
  text: string | undefined,
  slot: number = Feature.textTokens,
): void {
  if (!text) return;

  if (context.onText) {
    const tokens = context.onText(text);
    context.tally[slot]! += tokens;
    return;
  }

  const cache = context.textCache;
  // Conversation prefixes are repeated on every turn. Cache short strings
  // per estimator, bounded to at most 256 × 4096 UTF-16 code units.
  if (!cache || text.length > 4096) {
    context.tally[slot]! += countTextTokens(text, context.text);
    return;
  }
  let tokens = cache.get(text);
  if (tokens === undefined) {
    tokens = countTextTokens(text, context.text);
    if (cache.size >= 256) cache.clear();
    cache.set(text, tokens);
  }
  context.tally[slot]! += tokens;
}

export function addJson(context: WalkContext, value: unknown): void {
  addText(context, JSON.stringify(value));
}

/** The exact (unrounded) estimate of the features counted so far. */
export function tallyValue(context: WalkContext): number {
  const { tally, weights } = context;
  let value = 0;
  for (let index = 0; index < tally.length; index++)
    value += tally[index]! * weights[index]!;
  return value;
}

export function addTally(target: Float64Array, source: Float64Array): void {
  for (let index = 0; index < source.length; index++)
    target[index]! += source[index]!;
}
