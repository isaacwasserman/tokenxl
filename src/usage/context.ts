import type { ResolvedTokenEstimationOptions } from '../segments.ts'
import { Feature } from '../profile.ts'
import { countTextTokens } from '../segments.ts'

/**
 * The state of one walk. The walker only counts features into `tally`; the
 * estimate is the dot product of the tally and the profile weights.
 */
export interface WalkContext {
  tally: Float64Array
  weights: Float64Array
  text: ResolvedTokenEstimationOptions
  textCache: Map<string, number>
}

export function addText(context: WalkContext, text: string | undefined): void {
  if (!text)
    return

  // Conversation prefixes are repeated on every turn. Cache short strings
  // per estimator, bounded to at most 256 × 4096 UTF-16 code units.
  const cacheable = text.length <= 4096
  let tokens = cacheable ? context.textCache.get(text) : undefined
  if (tokens === undefined) {
    tokens = countTextTokens(text, context.text)
    if (cacheable) {
      if (context.textCache.size >= 256)
        context.textCache.clear()
      context.textCache.set(text, tokens)
    }
  }
  context.tally[Feature.textTokens]! += tokens
}

export function addJson(context: WalkContext, value: unknown): void {
  addText(context, JSON.stringify(value))
}

/** The exact (unrounded) estimate of the features counted so far. */
export function tallyValue(context: WalkContext): number {
  const { tally, weights } = context
  let value = 0
  for (let index = 0; index < tally.length; index++)
    value += tally[index]! * weights[index]!
  return value
}

export function addTally(target: Float64Array, source: Float64Array): void {
  for (let index = 0; index < source.length; index++)
    target[index]! += source[index]!
}
