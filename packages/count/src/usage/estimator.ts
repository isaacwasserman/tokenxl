import type {
  CompiledProfile,
  ModelProfile,
  ResolvedModelProfile,
} from "../profile.ts";
import { compileProfile, Feature, TALLY_LENGTH } from "../profile.ts";
import type { ModelProfileInput } from "../profiles.ts";
import { selectProfile } from "../profiles.ts";
import type { WalkContext } from "./context.ts";
import { tallyValue } from "./context.ts";
import { walkMessage } from "./messages.ts";
import type { ToolCache } from "./schema.ts";
import { walkToolSet } from "./schema.ts";
import type {
  CountOptions,
  EstimatorOptions,
  MessageBreakdown,
  UsageBreakdown,
  UsageInput,
} from "./types.ts";

export interface UsageEstimator {
  /** The profile with all defaults filled in. */
  readonly profile: ResolvedModelProfile;
  /** Estimates the input tokens of a request, or returns a breakdown when `breakdown` is set. */
  count: {
    (input: UsageInput, options?: { breakdown?: false }): number;
    (input: UsageInput, options: { breakdown: true }): UsageBreakdown;
    (input: UsageInput, options?: CountOptions): number | UsageBreakdown;
  };
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
  const compiled = compileProfile(profile, cache);
  const toolCache: ToolCache | undefined = cache ? new WeakMap() : undefined;

  function count(
    input: UsageInput,
    countOptions?: CountOptions,
  ): number | UsageBreakdown {
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
  };
}

const estimatorsByProfile = new WeakMap<ModelProfile, UsageEstimator>();
let defaultEstimator: UsageEstimator | undefined;

interface EstimateUsageOptions extends EstimatorOptions {
  profile?: ModelProfileInput;
  breakdown?: boolean;
}

/**
 * Estimates the input tokens of a request with AI SDK messages and tools.
 * Unless `cache` is `false`, keeps one estimator for each profile object, so
 * pass the same profile object on each call to reuse its caches. With
 * `toJsonSchema`, each call creates its own estimator.
 */
export function estimateUsage(
  input: UsageInput,
  options?: EstimateUsageOptions & { breakdown?: false },
): number;
export function estimateUsage(
  input: UsageInput,
  options: EstimateUsageOptions & { breakdown: true },
): UsageBreakdown;
export function estimateUsage(
  input: UsageInput,
  options?: EstimateUsageOptions,
): number | UsageBreakdown;
export function estimateUsage(
  input: UsageInput,
  options: EstimateUsageOptions = {},
): number | UsageBreakdown {
  const { profile, breakdown, ...estimatorOptions } = options;
  // A shared estimator would keep the first converter's results in its cache.
  const estimator =
    options.cache === false || options.toJsonSchema
      ? createUsageEstimator(profile, estimatorOptions)
      : getEstimator(profile);
  return estimator.count(input, { breakdown });
}

function getEstimator(input: ModelProfileInput | undefined): UsageEstimator {
  const profile = selectProfile(input);
  if (!profile) {
    defaultEstimator ??= createUsageEstimator();
    return defaultEstimator;
  }

  let estimator = estimatorsByProfile.get(profile);
  if (!estimator) {
    estimator = createUsageEstimator(profile);
    estimatorsByProfile.set(profile, estimator);
  }
  return estimator;
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
    if (messageBreakdown) breakdown!.messages.push(messageBreakdown);
  }
  if (input.tools)
    walkToolSet(input.tools, context, options, breakdown?.tools, toolCache);
}
