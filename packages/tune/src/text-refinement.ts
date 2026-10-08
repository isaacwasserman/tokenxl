import type { ResolvedModelProfile } from "@tokenxl/count/internal";
import { Feature, TALLY_LENGTH } from "@tokenxl/count/internal";
import type { Sample } from "./collect.ts";

import { fitTextRules, measureErrors, reportTextFields } from "./fit.ts";
import type { TextCompositionReport, TuneOptions } from "./types.ts";

/** Remove the measured single-message intercept, not estimated overhead. */
export function subtractIntercept(
  samples: Sample[],
  intercept: number,
): Sample[] {
  return samples.map((sample) => {
    const actual = sample.actual - intercept;
    if (!Number.isFinite(actual) || actual < 0)
      throw new RangeError(
        "tokenxl: A text request costs less than the measured request intercept.",
      );
    const tally = new Float64Array(TALLY_LENGTH);
    tally[Feature.textTokens] = sample.tally[Feature.textTokens]!;
    return { ...sample, actual, tally };
  });
}

/**
 * Refine text composition only; no structural coefficient or scale enters the search.
 * The selection samples choose among the initial text rules, the probe
 * calibration (round 0), and each refinement round.
 */
export async function refineTextRules(
  train: Sample[],
  selection: Sample[],
  calibrated: ResolvedModelProfile,
  initialText: ResolvedModelProfile["text"],
  options: Pick<TuneOptions, "signal">,
): Promise<{ profile: ResolvedModelProfile; report: TextCompositionReport }> {
  const judged = selection.length ? selection : train;
  const before = measureErrors(train, calibrated);
  const beforeSelection = selection.length
    ? measureErrors(selection, calibrated)
    : null;
  const fallback = { ...calibrated, text: initialText };
  // Probes of isolated segments miss the merges that an efficient tokenizer
  // makes in natural text. When the initial rules fit the natural text
  // better, as for tokenizers close to o200k, the refinement starts there.
  const start =
    measureErrors(train, fallback).loss < before.loss ? fallback : calibrated;
  let current = start;
  let best = calibrated;
  let bestLoss = beforeSelection?.loss ?? before.loss;
  let selected: TextCompositionReport["selected"] = 0;
  const rounds = 4;
  for (let round = 1; round <= rounds; round++) {
    options.signal?.throwIfAborted();
    current = fitTextRules(train, current, start, options);
    const loss = measureErrors(judged, current).loss;
    if (loss < bestLoss - 1e-12) {
      best = current;
      bestLoss = loss;
      selected = round;
    }
    // Release the event loop so cancellation works during local optimization.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  // Tuned rules that do not beat the initial ones would only add noise.
  if (measureErrors(judged, fallback).loss <= bestLoss) {
    best = fallback;
    selected = "initial";
  }
  return {
    profile: best,
    report: {
      rounds,
      selected,
      train: { before, after: measureErrors(train, best) },
      selection: beforeSelection
        ? { before: beforeSelection, after: measureErrors(selection, best) }
        : null,
      fields: reportTextFields(train, calibrated, best),
    },
  };
}
