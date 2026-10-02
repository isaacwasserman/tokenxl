import type { CompiledProfile, ModelProfile, ResolvedModelProfile } from '../profile.ts'
import type { WalkContext } from './context.ts'
import type { ToolCache } from './schema.ts'
import type { CountOptions, EstimatorOptions, MessageBreakdown, UsageBreakdown, UsageInput } from './types.ts'
import { compileProfile, Feature, TALLY_LENGTH } from '../profile.ts'
import { tallyValue } from './context.ts'
import { walkMessage } from './messages.ts'
import { walkToolSet } from './schema.ts'

export interface UsageEstimator {
  /** The profile with all defaults filled in. */
  readonly profile: ResolvedModelProfile
  /** Estimates the input tokens of a request, or returns a breakdown when `breakdown` is set. */
  count: {
    (input: UsageInput, options?: { breakdown?: false }): number
    (input: UsageInput, options: { breakdown: true }): UsageBreakdown
    (input: UsageInput, options?: CountOptions): number | UsageBreakdown
  }
}

/**
 * Creates an estimator for one model profile. Reuse it: it resolves the
 * profile once and caches the cost of each tool object, so a tool set that
 * is sent on every turn is walked only once. Do not mutate a tool after the
 * estimator has seen it.
 */
export function createUsageEstimator(profile?: ModelProfile, options: EstimatorOptions = {}): UsageEstimator {
  const compiled = compileProfile(profile)
  const toolCache: ToolCache = new WeakMap()

  function count(input: UsageInput, countOptions?: CountOptions): number | UsageBreakdown {
    const context = createContext(compiled)

    if (!countOptions?.breakdown) {
      walkInput(input, context, toolCache, options)
      return Math.round(tallyValue(context))
    }

    const breakdown: UsageBreakdown = {
      total: 0,
      baseOverhead: tallyValue(context),
      messages: [],
      tools: { total: 0, overhead: 0, definitions: Object.create(null) },
    }

    for (const message of input.messages) {
      const messageBreakdown: MessageBreakdown = { role: message.role, total: 0, overhead: 0, parts: [] }
      walkMessage(message, context, messageBreakdown)
      breakdown.messages.push(messageBreakdown)
    }
    if (input.tools)
      walkToolSet(input.tools, context, toolCache, options, breakdown.tools)

    breakdown.total = Math.round(tallyValue(context))
    return breakdown
  }

  return {
    profile: compiled.profile,
    count: count as UsageEstimator['count'],
  }
}

const estimatorsByProfile = new WeakMap<ModelProfile, UsageEstimator>()
let defaultEstimator: UsageEstimator | undefined

/**
 * Estimates the input tokens of a request with AI SDK messages and tools.
 * Keeps one estimator for each profile object, so pass the same profile
 * object on each call to reuse the tool cache.
 */
export function estimateUsage(input: UsageInput, options?: { profile?: ModelProfile, breakdown?: false }): number
export function estimateUsage(input: UsageInput, options: { profile?: ModelProfile, breakdown: true }): UsageBreakdown
export function estimateUsage(input: UsageInput, options?: { profile?: ModelProfile, breakdown?: boolean }): number | UsageBreakdown
export function estimateUsage(input: UsageInput, options: { profile?: ModelProfile, breakdown?: boolean } = {}): number | UsageBreakdown {
  return getEstimator(options.profile).count(input, { breakdown: options.breakdown })
}

function getEstimator(profile: ModelProfile | undefined): UsageEstimator {
  if (!profile)
    return defaultEstimator ??= createUsageEstimator()

  let estimator = estimatorsByProfile.get(profile)
  if (!estimator) {
    estimator = createUsageEstimator(profile)
    estimatorsByProfile.set(profile, estimator)
  }
  return estimator
}

/** Counts the features of a request without weighting them. */
export function tallyUsage(input: UsageInput, compiled: CompiledProfile, toolCache: ToolCache = new WeakMap(), options: EstimatorOptions = {}): Float64Array {
  const context = createContext(compiled)
  walkInput(input, context, toolCache, options)
  return context.tally
}

function createContext(compiled: CompiledProfile): WalkContext {
  const tally = new Float64Array(TALLY_LENGTH)
  tally[Feature.baseOverhead] = 1
  return { tally, weights: compiled.weights, text: compiled.text, textCache: compiled.textCache }
}

function walkInput(input: UsageInput, context: WalkContext, toolCache: ToolCache, options: EstimatorOptions): void {
  for (const message of input.messages)
    walkMessage(message, context)
  if (input.tools)
    walkToolSet(input.tools, context, toolCache, options)
}
