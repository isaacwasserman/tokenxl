import type { ModelMessage } from "ai";
import type {
  ModelProfile,
  ProfileField,
  ResolvedModelProfile,
} from "../profile.ts";
import type { UsageInput } from "../usage/types.ts";
import type { TextField } from "./text.ts";

/** Tokens a provider billed for one request. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/** A count, with the tokens billed for it when counting is not free. */
export interface CountResult {
  count: number;
  usage?: TokenUsage;
}

export type GroundTruthCounter = (
  input: UsageInput,
) => number | CountResult | PromiseLike<number | CountResult>;

/** Response messages, with the tokens billed for them. Empty or `null` messages end the conversation. */
export interface ModelResponse {
  messages: readonly ModelMessage[] | null;
  usage?: TokenUsage;
}

/**
 * Generates the model's response to a history that ends with a user turn and
 * returns its messages, as AI SDK `response.messages` does, or a
 * `ModelResponse` with billed usage. Return `null` to end the conversation,
 * for example after an incomplete response.
 */
export type ModelInvoker = (
  input: UsageInput,
  options: { signal?: AbortSignal },
) =>
  | readonly ModelMessage[]
  | ModelResponse
  | null
  | PromiseLike<readonly ModelMessage[] | ModelResponse | null>;

export type TuneStage = "text" | "overhead" | "reasoning" | "validation";

/** One counter or model call. Times are milliseconds from the start of the run. */
export interface TuneCall {
  kind: "count" | "generate";
  stage: TuneStage;
  start: number;
  end: number;
  /** Present when the counter or model reported billed tokens. */
  usage?: TokenUsage;
}

/** One phase of the run. Times are milliseconds from the start of the run. */
export interface TunePhase {
  stage: TuneStage;
  phase: "collect" | "generate" | "fit";
  start: number;
  end: number;
}

export interface ErrorMetrics {
  count: number;
  /** Mean absolute error in tokens. */
  mae: number;
  /** Signed error in the total estimated tokens, as a percentage. */
  aggregateError: number;
  /** Mean squared relative error; zero-token requests use a denominator of 1. */
  loss: number;
  /** Mean absolute percentage error. */
  mape: number;
  /** Maximum absolute percentage error. */
  maxError: number;
  /** Signed mean percentage error. */
  meanError: number;
}

export interface FieldReport {
  field: ProfileField | `text.${string}`;
  initial: number;
  final: number;
  /** Whether training data support fitting this field. Text values can still have equivalent plateaus. */
  identifiable: boolean;
  /** `invalid`: the fit produced an impossible value, such as a nonpositive cost per payload character. */
  reason?: "absent" | "collinear" | "invalid";
}

/** How the tuner reaches a model: the same interface for every provider. */
export interface ProviderAdapter {
  /** The provider's input-token count for a request. */
  countTokens: GroundTruthCounter;
  /**
   * Generates responses for reasoning calibration: at most 10 calls on
   * built-in prompts. Model calls usually consume credits.
   */
  invokeModel?: ModelInvoker;
  /** Whether the provider accepts a request; probes it rejects are skipped. */
  supportsInput?: (input: UsageInput) => boolean | PromiseLike<boolean>;
}

export interface TuneOptions extends ProviderAdapter {
  initial?: ModelProfile;
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?: (event: TuneProgress) => void;
}

export type TuneProgress =
  | {
      stage: "text" | "overhead" | "reasoning" | "validation";
      phase: "collect";
      completed: number;
      total: number;
    }
  | { stage: "reasoning"; phase: "generate"; completed: number; total: number }
  | { stage: "text" | "overhead" | "reasoning"; phase: "fit" };

export interface TextCalibrationReport {
  samples: number;
  multiplierSamples: number;
  /** Unique text fragments counted directly to remove text error from overheads. */
  overheadTextSamples: number;
  /** Scale measured from anchors; locked before measuring individual rules. */
  multiplier: number;
  /** Nuisance intercept: request plus single-message overhead. */
  intercept: number;
  rmse: number;
  rSquared: number;
  rules: TextRuleCalibrationReport[];
  /** Natural-text refinement; structural features and the measured scale stay fixed. */
  composition: TextCompositionReport | null;
  context: {
    count: number;
    rmse: number;
    maxError: number;
    meanError: number;
  } | null;
}

export interface TextCompositionReport {
  rounds: number;
  /** `initial`: the initial text rules; 0: the probe calibration; otherwise the refinement round. */
  selected: "initial" | number;
  train: { before: ErrorMetrics; after: ErrorMetrics };
  selection: { before: ErrorMetrics; after: ErrorMetrics } | null;
  fields: FieldReport[];
}

export interface TextRuleCalibrationReport extends FieldReport {
  probes: number;
  /** Rules measured together because they share a gate. */
  coupledWith?: TextField[];
  /** Token RMSE of the observed before/after count differences. */
  beforeRmse: number;
  afterRmse: number;
}

export interface TuneReport {
  /** Calls through to the ground-truth counter; shared controls are counted once. */
  counterCalls: number;
  /** Where the time and billed tokens went. */
  timing: { total: number; phases: TunePhase[]; calls: TuneCall[] };
  text: TextCalibrationReport;
  overhead: {
    probes: number;
    samples: number;
    /** Number of independently measurable structural coefficients. */
    rank: number;
    /** Calibration token errors after subtracting directly measured text costs. */
    contrasts: { rmse: number; maxError: number; exactFraction: number };
    before: ErrorMetrics;
    after: ErrorMetrics;
  };
  /** Present when `invokeModel` was given. */
  reasoning: ReasoningReport | null;
  validation: { before: ErrorMetrics; after: ErrorMetrics } | null;
  fields: FieldReport[];
}

export interface ReasoningMetrics {
  /** Hidden reasoning alone: the count with the payload parts minus the count without them. */
  reasoning: { before: ErrorMetrics; after: ErrorMetrics };
  /** Complete requests. */
  request: { before: ErrorMetrics; after: ErrorMetrics };
}

export interface ReasoningReport {
  /** Calls to `invokeModel`. */
  invocations: number;
  counterCalls: number;
  /** The generated histories, for reuse; they cost credits to collect. */
  histories: UsageInput[];
  /** Why the costs kept their starting values, if they did. */
  reason?: FieldReport["reason"];
  /**
   * Histories with reasoning in the current turn and in previous turns.
   * `countReasoningInPreviousTurns` is measured only when both are present.
   */
  turns: { currentTurn: number; previousTurns: number };
  perReasoningPayloadChar: number;
  reasoningPayloadEnvelopeChars: number;
  countReasoningInPreviousTurns: boolean;
  /** Errors on the generated histories, before and after the fit. */
  metrics: ReasoningMetrics;
}

export interface TuneResult {
  /**
   * The tuned profile. Without `invokeModel`, or when the model did not
   * reason, the reasoning costs keep their initial values.
   */
  profile: ResolvedModelProfile;
  report: TuneReport;
}
