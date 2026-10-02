import type { ResolvedTokenEstimationOptions } from './segments.ts'
import type { TextProfile } from './types.ts'
import { resolveTokenEstimationOptions } from './segments.ts'

/**
 * The overhead and scale factors of one model. All fields are optional;
 * a missing field takes its value from `DEFAULT_PROFILE`.
 */
export interface ModelProfile {
  /** Scale factor for all estimated text: content, tool names, descriptions, property names and enum values. */
  contentMultiplier?: number
  /** Tokens added once to every request. */
  baseOverhead?: number
  /** Tokens added for each message, including its role. */
  perMessage?: number
  /** Extra tokens added for each system message. */
  perSystem?: number
  /** Tokens added once when the request has at least one tool. */
  toolsExist?: number
  /** Tokens added for each tool after the first. */
  perTool?: number
  /** Tokens added for each tool with a description. */
  perDesc?: number
  /** Tokens added for the first property of each object in a tool schema. */
  perFirstProp?: number
  /** Tokens added for each property after the first in a tool schema object. */
  perAdditionalProp?: number
  /** Tokens added for each tool schema property with a description. */
  perPropDesc?: number
  /** Tokens added for each tool schema property with an `enum` or a `const`. */
  perEnum?: number
  /** Tokens added for each tool schema property that is an object. */
  perNestedObject?: number
  /** Tokens added for each tool schema property that is an array of objects. */
  perArrayOfObjects?: number
  /** Tokens added for each tool call part. */
  perToolCall?: number
  /** Tokens added for each tool result part. */
  perToolResult?: number
  /** Tokens for each image, independent of its size. */
  perImage?: number
  /** Tokens for each file, independent of its size. */
  perFile?: number
  /** Tokens added for each reasoning part. */
  perReasoning?: number
  /** Ratios of the text rules. */
  text?: TextProfile
}

export type ProfileField = Exclude<keyof ModelProfile, 'text'>

/** A profile with every field set. */
export type ResolvedModelProfile = Required<Omit<ModelProfile, 'text'>> & { text: TextProfile }

/**
 * Approximate values for OpenAI chat models, to match the o200k calibration
 * of the text rules. Tune a profile for each other model.
 */
export const DEFAULT_PROFILE: Readonly<Required<Omit<ModelProfile, 'text'>>> = Object.freeze({
  contentMultiplier: 1,
  baseOverhead: 3,
  perMessage: 4,
  perSystem: 0,
  toolsExist: 24,
  perTool: 6,
  perDesc: 2,
  perFirstProp: 5,
  perAdditionalProp: 3,
  perPropDesc: 2,
  perEnum: 7,
  perNestedObject: -3,
  perArrayOfObjects: 1,
  perToolCall: 0,
  perToolResult: 0,
  perImage: 85,
  perFile: 100,
  perReasoning: 0,
})

/** Merges a partial profile with `DEFAULT_PROFILE`. The `text` block merges one level deep. */
export function resolveProfile(profile: ModelProfile = {}): ResolvedModelProfile {
  const resolved = { ...DEFAULT_PROFILE, text: {} } as ResolvedModelProfile
  for (const key of Object.keys(profile) as Array<keyof ModelProfile>) {
    const value = profile[key]
    if (value === undefined)
      continue
    if (key === 'text')
      resolved.text = { ...(value as TextProfile) }
    else
      resolved[key] = value as number
  }
  return resolved
}

/** The order of the structural features in a tally. The text tokens come last. */
export const FEATURE_FIELDS: readonly Exclude<ProfileField, 'contentMultiplier'>[] = [
  'baseOverhead',
  'perMessage',
  'perSystem',
  'toolsExist',
  'perTool',
  'perDesc',
  'perFirstProp',
  'perAdditionalProp',
  'perPropDesc',
  'perEnum',
  'perNestedObject',
  'perArrayOfObjects',
  'perToolCall',
  'perToolResult',
  'perImage',
  'perFile',
  'perReasoning',
]

/** Index of each feature in a tally. */
export const Feature = {
  baseOverhead: 0,
  perMessage: 1,
  perSystem: 2,
  toolsExist: 3,
  perTool: 4,
  perDesc: 5,
  perFirstProp: 6,
  perAdditionalProp: 7,
  perPropDesc: 8,
  perEnum: 9,
  perNestedObject: 10,
  perArrayOfObjects: 11,
  perToolCall: 12,
  perToolResult: 13,
  perImage: 14,
  perFile: 15,
  perReasoning: 16,
  textTokens: 17,
} as const

export const TALLY_LENGTH: number = FEATURE_FIELDS.length + 1

/** A profile in the form the walker uses: one weight for each tally slot. */
export interface CompiledProfile {
  profile: ResolvedModelProfile
  weights: Float64Array
  text: ResolvedTokenEstimationOptions
  textCache: Map<string, number>
}

export function compileProfile(profile?: ModelProfile): CompiledProfile {
  const resolved = resolveProfile(profile)
  const weights = new Float64Array(TALLY_LENGTH)
  for (let index = 0; index < FEATURE_FIELDS.length; index++)
    weights[index] = resolved[FEATURE_FIELDS[index]!]
  weights[Feature.textTokens] = resolved.contentMultiplier

  return {
    profile: resolved,
    weights,
    text: resolveTokenEstimationOptions(resolved.text),
    textCache: new Map(),
  }
}
