import type { ResolvedModelProfile, UsageInput } from "@tokenxl/count/internal";
import {
  compileProfile,
  FEATURE_FIELDS,
  Feature,
  resolveProfile,
  tallyUsage,
} from "@tokenxl/count/internal";
import type { Collected, CollectionOptions, Sample } from "./collect.ts";
import { collectSamples } from "./collect.ts";
import { tuningCorpus } from "./corpus.ts";
import { measureErrors, solveLeastSquares } from "./fit.ts";
import {
  fitReasoning,
  fitStoredReasoning,
  generateHistories,
  REASONING_INVOCATIONS,
} from "./reasoning.ts";
import type { TextField } from "./text.ts";
import {
  estimateHistogramTokens,
  getTextValue,
  resolveTextRules,
} from "./text.ts";
import { calibrateText } from "./text-calibration.ts";
import { refineTextRules, subtractIntercept } from "./text-refinement.ts";
import type {
  FieldReport,
  ReasoningReport,
  TokenUsage,
  TuneCall,
  TuneOptions,
  TunePhase,
  TuneResult,
  TuneStage,
} from "./types.ts";

/**
 * Tunes a profile on the built-in corpus: text rules first, then overhead with
 * the entire text profile locked, then, with `invokeModel`, encrypted
 * reasoning costs with everything else locked.
 */
export async function tuneProfile(options: TuneOptions): Promise<TuneResult> {
  options.signal?.throwIfAborted();
  const {
    probes: designed,
    textSamples: trainInputs,
    textSelectionSamples: selectionInputs,
    validationSamples,
  } = tuningCorpus;
  // Times are reported in milliseconds from the start of the run.
  const origin = performance.now();
  const phases: TunePhase[] = [];
  const calls: TuneCall[] = [];
  const recordPhase = (
    stage: TuneStage,
    phase: TunePhase["phase"],
    start: number,
  ): void => {
    phases.push({
      stage,
      phase,
      start: start - origin,
      end: performance.now() - origin,
    });
  };
  const recordCall =
    (kind: TuneCall["kind"], stage: TuneStage) =>
    (call: { start: number; end: number; usage?: TokenUsage }): void => {
      calls.push({
        kind,
        stage,
        start: call.start - origin,
        end: call.end - origin,
        ...(call.usage ? { usage: call.usage } : {}),
      });
    };
  const initial = resolveProfile(options.initial);
  const collectionOptions: CollectionOptions = {
    ...options,
    onProgress: undefined,
  };
  const observations = new Map<UsageInput | string, Sample>();
  const accepted = new Map<UsageInput, boolean>();
  for (const input of [
    ...designed.overhead.flatMap((probe) => [probe.before, probe.after]),
    ...validationSamples,
  ])
    accepted.set(input, await (options.supportsInput?.(input) ?? true));
  const supported = (input: UsageInput): boolean => accepted.get(input) ?? true;
  const probes = {
    ...designed,
    overhead: designed.overhead.filter(
      (probe) => supported(probe.before) && supported(probe.after),
    ),
  };
  const ruleProbes = probes.textRules ?? [];
  const overheadInputs = probes.overhead.flatMap((probe) => [
    probe.before,
    probe.after,
  ]);
  const fragments = extractChargedTexts(overheadInputs, initial);
  const ruleInputs = ruleProbes.flatMap((probe) => [probe.before, probe.after]);
  const contextProbes = probes.textContext ?? [];
  const contextInputs = contextProbes.flatMap((probe) => [
    probe.before,
    probe.after,
  ]);
  const contextStart = probes.text.length + ruleInputs.length;
  const fragmentStart = contextStart + contextInputs.length;
  const trainStart = fragmentStart + fragments.inputs.length;
  const selectionStart = trainStart + trainInputs.length;
  const textInputs = [
    ...probes.text,
    ...ruleInputs,
    ...contextInputs,
    ...fragments.inputs,
    ...trainInputs,
    ...selectionInputs,
  ];
  const validationInputs = validationSamples.filter(supported);

  async function collectStageSamples(
    stage: TuneStage,
    inputs: readonly UsageInput[],
    profile: ResolvedModelProfile,
  ): Promise<Collected> {
    const start = performance.now();
    const collected = await collectSamples(inputs, profile, {
      ...collectionOptions,
      observations,
      onProgress: (event) => {
        if (event.phase === "collect")
          options.onProgress?.({ stage, ...event });
      },
      onCall: recordCall("count", stage),
    });
    recordPhase(stage, "collect", start);
    return collected;
  }

  const textData = await collectStageSamples("text", textInputs, initial);
  const textFitStart = performance.now();
  const anchors = [
    ...new Set(textData.inputIndices.slice(0, probes.text.length)),
  ].map((index) => textData.samples[index]!);
  const measuredRules = ruleProbes.map((probe, index) => ({
    field: probe.field,
    before:
      textData.samples[textData.inputIndices[probes.text.length + index * 2]!]!,
    after:
      textData.samples[
        textData.inputIndices[probes.text.length + index * 2 + 1]!
      ]!,
  }));
  const calibrated = calibrateText(
    anchors,
    measuredRules,
    initial,
    options.signal,
  );
  const fragmentCosts = new Map(
    fragments.inputs.map((input, n) => [
      input.messages[0]!.content as string,
      textData.samples[textData.inputIndices[fragmentStart + n]!]!.actual -
        calibrated.report.intercept,
    ]),
  );
  // These costs already include the model's text scale. Measuring them avoids
  // assigning heuristic text errors to structural coefficients.
  const measuredText = fragments.parts.map((parts) =>
    parts.reduce((sum, part) => sum + fragmentCosts.get(part)!, 0),
  );
  const getStageSamples = (start: number, length: number): Sample[] =>
    [...new Set(textData.inputIndices.slice(start, start + length))].map(
      (index) => textData.samples[index]!,
    );
  const composition = trainInputs.length
    ? await refineTextRules(
        subtractIntercept(
          getStageSamples(trainStart, trainInputs.length),
          calibrated.report.intercept,
        ),
        subtractIntercept(
          getStageSamples(selectionStart, selectionInputs.length),
          calibrated.report.intercept,
        ),
        calibrated.profile,
        initial.text,
        options,
      )
    : null;
  const locked = composition?.profile ?? calibrated.profile;
  const resolvedText = resolveTextRules(locked.text);
  const contextErrors = contextProbes.map((_, n) => {
    const before =
      textData.samples[textData.inputIndices[contextStart + n * 2]!]!;
    const after =
      textData.samples[textData.inputIndices[contextStart + n * 2 + 1]!]!;
    return (
      locked.contentMultiplier *
        (estimateHistogramTokens(after.text, resolvedText) -
          estimateHistogramTokens(before.text, resolvedText)) -
      (after.actual - before.actual)
    );
  });
  const context = contextErrors.length
    ? {
        count: contextErrors.length,
        rmse: Math.sqrt(
          contextErrors.reduce((sum, error) => sum + error ** 2, 0) /
            contextErrors.length,
        ),
        maxError: Math.max(...contextErrors.map(Math.abs)),
        meanError:
          contextErrors.reduce((sum, error) => sum + error, 0) /
          contextErrors.length,
      }
    : null;
  const text = {
    ...calibrated.report,
    samples: textData.samples.length,
    overheadTextSamples: fragments.inputs.length,
    composition: composition?.report ?? null,
    context,
  };
  recordPhase("text", "fit", textFitStart);
  options.onProgress?.({ stage: "text", phase: "fit" });
  options.signal?.throwIfAborted();

  const overheadData = await collectStageSamples(
    "overhead",
    overheadInputs,
    locked,
  );
  const overheadFitStart = performance.now();
  // The patch size changes the patch counts, not the samples: fit each
  // candidate size and keep the one whose contrasts fit best.
  const sampleInputs: UsageInput[] = [];
  overheadData.inputIndices.forEach((sample, index) => {
    sampleInputs[sample] = overheadInputs[index]!;
  });
  let fitted: ReturnType<typeof fitOverhead> | undefined;
  let fittedSamples = overheadData.samples;
  for (const imagePatchSize of new Set([
    locked.imagePatchSize,
    ...IMAGE_PATCH_SIZES,
  ])) {
    const geometry = compileProfile({ ...locked, imagePatchSize });
    const samples = overheadData.samples.map((sample, index) => {
      const tally = sample.tally.slice();
      tally[Feature.perImagePatch] = tallyUsage(
        sampleInputs[index]!,
        geometry,
        {},
        () => 0,
      )[Feature.perImagePatch]!;
      return { ...sample, tally };
    });
    const candidate = fitOverhead(
      probes.overhead.map((_, index) => ({
        before: samples[overheadData.inputIndices[index * 2]!]!,
        after: samples[overheadData.inputIndices[index * 2 + 1]!]!,
        beforeText: measuredText[index * 2]!,
        afterText: measuredText[index * 2 + 1]!,
      })),
      { ...locked, imagePatchSize },
      options.signal,
    );
    if (!fitted || candidate.contrasts.rmse < fitted.contrasts.rmse - 1e-9) {
      fitted = candidate;
      fittedSamples = samples;
    }
    // Without patch probes, every size fits equally.
    if (samples.every((sample) => !sample.tally[Feature.perImagePatch])) break;
  }
  fitted = fitted!;
  recordPhase("overhead", "fit", overheadFitStart);
  options.onProgress?.({ stage: "overhead", phase: "fit" });
  options.signal?.throwIfAborted();

  // Generation runs only after the free phases succeed, so a failure there costs no model calls.
  let profile = fitted.profile;
  let reasoning: ReasoningReport | null = null;
  if (options.invokeModel) {
    const generateStart = performance.now();
    let generatedCalls = 0;
    const { histories, invocations } = await generateHistories(
      options.invokeModel,
      {
        concurrency: options.concurrency,
        signal: options.signal,
        onProgress: () =>
          options.onProgress?.({
            stage: "reasoning",
            phase: "generate",
            completed: ++generatedCalls,
            total: REASONING_INVOCATIONS,
          }),
        onCall: recordCall("generate", "reasoning"),
      },
    );
    recordPhase("reasoning", "generate", generateStart);
    const fitStart = performance.now();
    const fit = await fitReasoning(histories, profile, {
      ...collectionOptions,
      observations,
      onProgress: (event) =>
        options.onProgress?.({ stage: "reasoning", ...event }),
      onCall: recordCall("count", "reasoning"),
    });
    recordPhase("reasoning", "fit", fitStart);
    options.onProgress?.({ stage: "reasoning", phase: "fit" });
    options.signal?.throwIfAborted();
    // Stored items are estimated from the payload costs just fitted.
    const stored = fit.reason
      ? undefined
      : fitStoredReasoning(histories, fit.profile);
    profile = stored?.profile ?? fit.profile;
    reasoning = {
      invocations,
      counterCalls: fit.counterCalls,
      histories,
      ...(fit.reason ? { reason: fit.reason } : {}),
      turns: fit.histories,
      perReasoningPayloadChar: fit.profile.perReasoningPayloadChar,
      reasoningPayloadEnvelopeChars: fit.profile.reasoningPayloadEnvelopeChars,
      countReasoningInPreviousTurns: fit.profile.countReasoningInPreviousTurns,
      storedReasoning: {
        items: stored?.items ?? 0,
        summarized: stored?.summarized ?? 0,
        perStoredReasoning: profile.perStoredReasoning,
        storedReasoningSummaryScale: profile.storedReasoningSummaryScale,
      },
      metrics: fit.metrics,
    };
  }
  const validationData = validationInputs.length
    ? await collectStageSamples("validation", validationInputs, profile)
    : null;

  const fields: FieldReport[] = FEATURE_FIELDS.map((field, index) => {
    const reason = fitted.reasons.get(index);
    return {
      field,
      initial: initial[field],
      final: profile[field],
      identifiable: !reason,
      ...(reason ? { reason } : {}),
    };
  });
  fields.push({
    field: "imagePatchSize",
    initial: initial.imagePatchSize,
    final: profile.imagePatchSize,
    identifiable: !fitted.reasons.has(Feature.perImagePatch),
  });
  fields.push({
    field: "contentMultiplier",
    initial: initial.contentMultiplier,
    final: text.multiplier,
    identifiable: true,
  });
  fields.push(
    ...text.rules.map((rule) => {
      const refined = composition?.report.fields.find(
        (field) => field.field === rule.field,
      );
      return {
        ...(refined?.identifiable ? refined : rule),
        initial: rule.initial,
        final: getTextValue(
          resolvedText,
          rule.field.replace(
            /^text\.(languageCharsPerToken\.)?/,
            "",
          ) as TextField,
        ),
      };
    }),
  );
  return {
    profile: roundCosts(profile),
    report: {
      counterCalls:
        textData.counterCalls +
        overheadData.counterCalls +
        (reasoning?.counterCalls ?? 0) +
        (validationData?.counterCalls ?? 0),
      timing: { total: performance.now() - origin, phases, calls },
      text,
      overhead: {
        probes: probes.overhead.length,
        samples: overheadData.samples.length,
        rank: FEATURE_FIELDS.length - fitted.reasons.size,
        contrasts: fitted.contrasts,
        before: measureErrors(overheadData.samples, initial),
        after: measureErrors(fittedSamples, fitted.profile),
      },
      reasoning,
      validation: validationData
        ? {
            before: measureErrors(validationData.samples, initial),
            after: measureErrors(validationData.samples, profile),
          }
        : null,
      fields,
    },
  };
}

// Patch edges of measured providers, in pixels: 28 (Anthropic), 32 (OpenAI
// patch models), 512 (OpenAI tile models), and common vision encoder patches.
const IMAGE_PATCH_SIZES = [14, 16, 28, 32, 512];

/**
 * Remove numerical noise from fitted costs: snap near-integers, and keep four
 * decimals otherwise. Text ratios keep full precision, because a rounded ratio
 * can move the length at which an estimate changes.
 */
function roundCosts(profile: ResolvedModelProfile): ResolvedModelProfile {
  const rounded = { ...profile };
  for (const field of [
    "contentMultiplier",
    ...FEATURE_FIELDS,
    "perReasoningPayloadChar",
    "reasoningPayloadEnvelopeChars",
    "perStoredReasoning",
    "storedReasoningSummaryScale",
  ] as const) {
    const value = profile[field];
    const integer = Math.round(value);
    rounded[field] =
      Math.abs(value - integer) < 1e-6
        ? integer
        : Math.round(value * 1e4) / 1e4;
  }
  return rounded;
}

/** Solve measured contrasts with rank-revealing QR, without iterative fitting. */
function fitOverhead(
  probes: {
    before: Sample;
    after: Sample;
    beforeText: number;
    afterText: number;
  }[],
  locked: ResolvedModelProfile,
  signal?: AbortSignal,
): {
  profile: ResolvedModelProfile;
  reasons: Map<number, "absent" | "collinear">;
  contrasts: { rmse: number; maxError: number; exactFraction: number };
} {
  const rows: number[][] = [];
  const targets: number[] = [];
  const anchors = new Set<Sample>();
  for (const probe of probes) {
    signal?.throwIfAborted();
    // Absolute controls identify baseOverhead, which cancels in every delta.
    if (!anchors.has(probe.before)) {
      anchors.add(probe.before);
      rows.push(FEATURE_FIELDS.map((_, index) => probe.before.tally[index]!));
      targets.push(probe.before.actual - probe.beforeText);
    }
    rows.push(
      FEATURE_FIELDS.map(
        (_, index) => probe.after.tally[index]! - probe.before.tally[index]!,
      ),
    );
    targets.push(
      probe.after.actual -
        probe.before.actual -
        (probe.afterText - probe.beforeText),
    );
  }
  // Solve changes from the initial profile so unmeasurable fields retain it.
  const rhs = targets.map(
    (target, n) =>
      target -
      FEATURE_FIELDS.reduce(
        (sum, field, index) => sum + rows[n]![index]! * locked[field],
        0,
      ),
  );
  const { coefficients, reasons } = solveLeastSquares(rows, rhs, signal);
  const profile = { ...locked };
  FEATURE_FIELDS.forEach((field, index) => {
    profile[field] += coefficients[index] ?? 0;
    if (!Number.isFinite(profile[field]))
      throw new RangeError(
        "tokenxl: Overhead calibration produced a nonfinite coefficient.",
      );
  });
  const errors = probes.map(
    (probe) =>
      FEATURE_FIELDS.reduce(
        (sum, field, n) =>
          sum +
          profile[field] * (probe.after.tally[n]! - probe.before.tally[n]!),
        0,
      ) -
      (probe.after.actual -
        probe.before.actual -
        probe.afterText +
        probe.beforeText),
  );
  return {
    profile,
    reasons,
    contrasts: {
      rmse: Math.sqrt(
        errors.reduce((sum, error) => sum + error ** 2, 0) / errors.length,
      ),
      maxError: Math.max(...errors.map(Math.abs)),
      exactFraction:
        errors.filter((error) => Math.abs(error) < 1e-7).length / errors.length,
    },
  };
}

/** Extract the exact same text occurrences that the estimator charges. */
function extractChargedTexts(
  inputs: readonly UsageInput[],
  initial: ResolvedModelProfile,
): { inputs: UsageInput[]; parts: string[][] } {
  const compiled = compileProfile(initial);
  const unique = new Map<string, UsageInput>();
  const parts = inputs.map((input) => {
    const occurrences: string[] = [];
    tallyUsage(input, compiled, {}, (text) => {
      occurrences.push(text);
      if (!unique.has(text))
        unique.set(text, { messages: [{ role: "user", content: text }] });
      return 0;
    });
    return occurrences;
  });
  return { inputs: [...unique.values()], parts };
}
