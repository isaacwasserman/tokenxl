import type { CompiledProfile, ResolvedModelProfile } from "../profile.ts";
import { compileProfile, Feature, TALLY_LENGTH } from "../profile.ts";
import type { ModelProfileInput } from "../profiles.ts";
import { countTextTokens } from "../segments.ts";
import { sliceText, splitText } from "../text.ts";
import type { WalkContext } from "./context.ts";
import { tallyValue } from "./context.ts";
import { walkMessage } from "./messages.ts";
import type { ToolCache } from "./schema.ts";
import { walkToolSet } from "./schema.ts";
import type {
  CountOptions,
  EstimatorOptions,
  MessageBreakdown,
  TextInput,
  UsageBreakdown,
  UsageInput,
} from "./types.ts";

export interface UsageEstimator {
  /** The profile with all defaults filled in. */
  readonly profile: ResolvedModelProfile;
  /**
   * Estimates the input tokens of a request (`{ messages, tools }`), or of a
   * text alone (`{ text }`), without request overhead.
   * With `breakdown`, returns where the tokens of a request come from.
   */
  count: {
    (input: UsageInput | TextInput, options?: { breakdown?: false }): number;
    (input: UsageInput, options: { breakdown: true }): UsageBreakdown;
    (input: UsageInput, options?: CountOptions): number | UsageBreakdown;
  };
  /** Whether a request or text has at most `limit` estimated tokens. */
  isWithinTokenLimit(input: UsageInput | TextInput, limit: number): boolean;
  /**
   * The part of a text between two token positions, like
   * `Array.prototype.slice()`. Negative positions count from the end.
   */
  sliceByTokens(text: string, start?: number, end?: number): string;
  /**
   * Splits a text into chunks of about `tokensPerChunk` tokens. `overlap`
   * repeats the last tokens of a chunk at the start of the next one; it is
   * kept below the chunk size.
   */
  splitByTokens(
    text: string,
    tokensPerChunk: number,
    options?: { overlap?: number },
  ): string[];
}

/**
 * Creates an estimator for one model profile. Reuse it: it resolves the
 * profile once and, unless `cache` is `false`, caches the cost of each tool
 * object and the estimates of repeated strings, so a tool set or conversation
 * prefix that is sent on every turn is walked only once. Do not mutate a tool
 * after a caching estimator has seen it.
 */
export function createUsageEstimator(
  profile?: ModelProfileInput,
  options: EstimatorOptions = {},
): UsageEstimator {
  const cache = options.cache !== false;
  const compiled = compileProfile(profile, cache, options.languageConfigs);
  const toolCache: ToolCache | undefined = cache ? new WeakMap() : undefined;
  // The text APIs apply the multiplier to the text alone.
  const textOptions = {
    ...compiled.text,
    contentMultiplier: compiled.profile.contentMultiplier,
  };

  function count(
    input: UsageInput | TextInput,
    countOptions?: CountOptions,
  ): number | UsageBreakdown {
    if (!("messages" in input)) {
      if (typeof input?.text !== "string")
        throw new TypeError(
          "tokenxl: Pass a request with `messages`, or `{ text }`.",
        );
      if (countOptions?.breakdown)
        throw new TypeError(
          "tokenxl: A breakdown needs a request with `messages`.",
        );
      return input.text ? countTextTokens(input.text, textOptions) : 0;
    }
    const context = createContext(compiled);

    if (!countOptions?.breakdown) {
      walkInput(input, context, options, toolCache);
      return Math.round(tallyValue(context));
    }

    const breakdown: UsageBreakdown = {
      total: 0,
      baseOverhead: tallyValue(context),
      messages: [],
      tools: { total: 0, overhead: 0, definitions: Object.create(null) },
    };

    walkInput(input, context, options, toolCache, breakdown);
    breakdown.total = Math.round(tallyValue(context));
    return breakdown;
  }

  return {
    profile: compiled.profile,
    count: count as UsageEstimator["count"],
    isWithinTokenLimit: (input, limit) => (count(input) as number) <= limit,
    sliceByTokens: (text, start = 0, end) =>
      text ? sliceText(text, start, end, textOptions) : "",
    splitByTokens: (text, tokensPerChunk, splitOptions = {}) =>
      text && tokensPerChunk > 0
        ? splitText(
            text,
            tokensPerChunk,
            splitOptions.overlap ?? 0,
            textOptions,
          )
        : [],
  };
}

/** Counts the features of a request without weighting them. */
export function tallyUsage(
  input: UsageInput,
  compiled: CompiledProfile,
  options: EstimatorOptions = {},
  onText?: (text: string) => number,
): Float64Array {
  const context = createContext(compiled);
  if (onText) context.onText = onText;
  walkInput(input, context, options);
  return context.tally;
}

function createContext(compiled: CompiledProfile): WalkContext {
  const tally = new Float64Array(TALLY_LENGTH);
  tally[Feature.baseOverhead] = 1;
  return {
    tally,
    weights: compiled.weights,
    text: compiled.text,
    images: compiled.images,
    ...(compiled.textCache ? { textCache: compiled.textCache } : {}),
  };
}

function walkInput(
  input: UsageInput,
  context: WalkContext,
  options: EstimatorOptions,
  toolCache?: ToolCache,
  breakdown?: UsageBreakdown,
): void {
  // Reasoning before the last user message belongs to an earlier turn.
  const lastUser = input.messages.findLastIndex(
    (message) => message.role === "user",
  );
  for (const [index, message] of input.messages.entries()) {
    context.priorTurn = index < lastUser;
    const messageBreakdown: MessageBreakdown | undefined = breakdown && {
      role: message.role,
      total: 0,
      overhead: 0,
      parts: [],
    };
    walkMessage(message, context, messageBreakdown);
    if (messageBreakdown) breakdown?.messages.push(messageBreakdown);
  }
  if (input.tools)
    walkToolSet(input.tools, context, options, breakdown?.tools, toolCache);
}
