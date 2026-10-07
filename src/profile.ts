import type { ModelProfileInput } from "./profiles.ts";
import { selectProfile } from "./profiles.ts";
import type {
  ResolvedTextProfile,
  ResolvedTokenEstimationOptions,
} from "./segments.ts";
import {
  resolveTextProfile,
  resolveTokenEstimationOptions,
} from "./segments.ts";
import type { TextProfile } from "./types.ts";

/**
 * The overhead and scale factors of one model. All fields are optional;
 * a missing field takes its value from `DEFAULT_PROFILE`.
 */
export interface ModelProfile {
  /** Scale applied to all visible text, including message and tool text. */
  contentMultiplier?: number;
  /** Tokens added once to every request. */
  baseOverhead?: number;
  /** Tokens added for each message, including its role. */
  perMessage?: number;
  /** Extra tokens added for each system message. */
  perSystem?: number;
  /** Tokens added once when the request has at least one tool. */
  toolsExist?: number;
  /** Tokens added for each tool after the first. */
  perTool?: number;
  /** Tokens added for each tool with a description. */
  perDesc?: number;
  /** Tokens added for the first property of each object in a tool schema. */
  perFirstProp?: number;
  /** Tokens added for each property after the first in a tool schema object. */
  perAdditionalProp?: number;
  /** Tokens added for each tool schema property with a description. */
  perPropDesc?: number;
  /** Tokens added for each tool schema property with an `enum` or a `const`. */
  perEnum?: number;
  /** Tokens added for each tool schema property that is an object. */
  perNestedObject?: number;
  /** Tokens added for each tool schema property that is an array of objects. */
  perArrayOfObjects?: number;
  /** Tokens added for each tool call part. */
  perToolCall?: number;
  /** Tokens added for each tool result part. */
  perToolResult?: number;
  /** Tokens for each image, independent of its size. */
  perImage?: number;
  /** Tokens for each file, independent of its size. */
  perFile?: number;
  /** Tokens added for each reasoning part without an encrypted payload; its text also counts. */
  perReasoning?: number;
  /** Tokens added for each enum value; const is charged only through perEnum. */
  perEnumValue?: number;
  /** Tokens added once for each schema with a required array, including an empty array. */
  perRequired?: number;
  /** Tokens added for each required name; names also count as text. */
  perRequiredProp?: number;
  /** Tokens added for each explicit additionalProperties keyword. */
  perAdditionalProperties?: number;
  /** Extra tokens for each `additionalProperties: true`, which some providers render as an open index signature. */
  perAdditionalPropertiesTrue?: number;
  /** Extra tokens for each schema node with an integer type. */
  perInteger?: number;
  /** Extra tokens for each schema node with a boolean type. */
  perBoolean?: number;
  /** Tokens added for each primitive array item schema, including union branches. */
  perArrayOfPrimitives?: number;
  /**
   * Tokens for each character of an encrypted reasoning payload (an Anthropic
   * `signature` or `redactedData`, or OpenAI `reasoningEncryptedContent`, once
   * per OpenAI reasoning item), after its envelope. This estimates the hidden
   * thinking; the visible summary text is not counted.
   */
  perReasoningPayloadChar?: number;
  /**
   * Characters at the start of each encrypted reasoning payload that cost
   * nothing: the encryption envelope, less any framing tokens. A payload costs
   * `perReasoningPayloadChar × (length − reasoningPayloadEnvelopeChars)`.
   */
  reasoningPayloadEnvelopeChars?: number;
  /**
   * Whether the model counts encrypted reasoning from previous turns (before
   * the last user message). Some models drop it, so it costs nothing.
   */
  countReasoningInPreviousTurns?: boolean;
  /** Ratios of the text rules. */
  text?: TextProfile;
}

/** The numeric fields; each is a weight in the tally. */
export type ProfileField = Exclude<
  keyof ModelProfile,
  "text" | "countReasoningInPreviousTurns"
>;

/** A profile with every field set. */
export type ResolvedModelProfile = Required<Omit<ModelProfile, "text">> & {
  text: ResolvedTextProfile;
};

/**
 * Model-neutral values: the o200k text rules of plain tokenx and approximate
 * request overhead. Tune a profile for each model.
 */
export const DEFAULT_PROFILE: Readonly<Required<Omit<ModelProfile, "text">>> =
  Object.freeze({
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
    perEnumValue: 0,
    perRequired: 0,
    perRequiredProp: 0,
    perAdditionalProperties: 0,
    perInteger: 0,
    perBoolean: 0,
    perArrayOfPrimitives: 0,
    perAdditionalPropertiesTrue: 0,
    // An upper bound for every measured model: the highest cost per character,
    // no envelope, and previous turns counted. Without a profile, overestimate.
    perReasoningPayloadChar: 0.43,
    reasoningPayloadEnvelopeChars: 0,
    countReasoningInPreviousTurns: true,
  });

/** Merges a partial profile with `DEFAULT_PROFILE` and its text rules with `DEFAULT_TEXT_PROFILE`. */
export function resolveProfile(
  profile: ModelProfileInput = {},
): ResolvedModelProfile {
  const selected = selectProfile(profile)!;
  const resolved = { ...DEFAULT_PROFILE } as ResolvedModelProfile;
  for (const key of Object.keys(selected) as Array<keyof ModelProfile>) {
    const value = selected[key];
    if (value !== undefined && key !== "text")
      (resolved as Record<string, unknown>)[key] = value;
  }
  resolved.text = resolveTextProfile(selected.text);
  return resolved;
}

/** Fields that are a weight of one tally slot each; the reasoning payload fields set four slots together. */
export const FEATURE_FIELDS: readonly Exclude<
  ProfileField,
  | "contentMultiplier"
  | "perReasoningPayloadChar"
  | "reasoningPayloadEnvelopeChars"
>[] = [
  "baseOverhead",
  "perMessage",
  "perSystem",
  "toolsExist",
  "perTool",
  "perDesc",
  "perFirstProp",
  "perAdditionalProp",
  "perPropDesc",
  "perEnum",
  "perNestedObject",
  "perArrayOfObjects",
  "perToolCall",
  "perToolResult",
  "perImage",
  "perFile",
  "perReasoning",
  "perEnumValue",
  "perRequired",
  "perRequiredProp",
  "perAdditionalProperties",
  "perInteger",
  "perBoolean",
  "perArrayOfPrimitives",
  "perAdditionalPropertiesTrue",
];

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
  perEnumValue: 17,
  perRequired: 18,
  perRequiredProp: 19,
  perAdditionalProperties: 20,
  perInteger: 21,
  perBoolean: 22,
  perArrayOfPrimitives: 23,
  perAdditionalPropertiesTrue: 24,
  // Reasoning payload blocks and characters, in the current turn and in previous
  // turns. Their weights come from the payload fields, not from one field each.
  reasoningPayloads: 25,
  reasoningPayloadChars: 26,
  previousReasoningPayloads: 27,
  previousReasoningPayloadChars: 28,
  textTokens: 29,
} as const;

export const TALLY_LENGTH: number = FEATURE_FIELDS.length + 5;

/** A profile in the form the walker uses: one weight for each tally slot. */
export interface CompiledProfile {
  profile: ResolvedModelProfile;
  weights: Float64Array;
  text: ResolvedTokenEstimationOptions;
  /** Token estimates of whole strings, when caching is enabled. */
  textCache?: Map<string, number>;
}

export function compileProfile(
  profile?: ModelProfileInput,
  cache = true,
): CompiledProfile {
  const resolved = resolveProfile(profile);
  const weights = new Float64Array(TALLY_LENGTH);
  for (let index = 0; index < FEATURE_FIELDS.length; index++)
    weights[index] = resolved[FEATURE_FIELDS[index]!];
  // perChar × (length − envelope) per block, as a per-block and a per-character weight.
  const perChar = resolved.perReasoningPayloadChar;
  const perBlock = -perChar * resolved.reasoningPayloadEnvelopeChars;
  const previous = resolved.countReasoningInPreviousTurns ? 1 : 0;
  weights[Feature.reasoningPayloads] = perBlock;
  weights[Feature.reasoningPayloadChars] = perChar;
  weights[Feature.previousReasoningPayloads] = previous * perBlock;
  weights[Feature.previousReasoningPayloadChars] = previous * perChar;
  weights[Feature.textTokens] = resolved.contentMultiplier;

  return {
    profile: resolved,
    weights,
    text: resolveTokenEstimationOptions({ ...resolved.text, cache }),
    ...(cache ? { textCache: new Map() } : {}),
  };
}
