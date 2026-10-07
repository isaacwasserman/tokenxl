import type { ResolvedModelProfile } from "../profile.ts";
import { compileProfile, Feature } from "../profile.ts";
import { listCandidateValues } from "./candidates.ts";
import type { Sample } from "./collect.ts";
import { throwIfAborted } from "./collect.ts";
import { summarizeErrors } from "./metrics.ts";
import {
  ALL_TEXT_FIELDS,
  containsTextField,
  estimateHistogramTokens,
  getTextValue,
  LANGUAGES,
  resolveTextRules,
  setTextValue,
} from "./text.ts";
import type { ErrorMetrics, FieldReport, TuneOptions } from "./types.ts";

export function measureErrors(
  samples: Sample[],
  profile: ResolvedModelProfile,
): ErrorMetrics {
  const text = resolveTextRules(profile.text);
  const weights = compileProfile(profile).weights;
  return summarizeErrors(
    samples.map((sample) => {
      // Every slot except text, which is recounted with this profile's text rules.
      let estimated =
        weights[Feature.textTokens]! *
        estimateHistogramTokens(sample.text, text);
      for (let index = 0; index < Feature.textTokens; index++)
        estimated += sample.tally[index]! * weights[index]!;
      return { actual: sample.actual, estimated: Math.round(estimated) };
    }),
  );
}

/** Search the count-changing thresholds one field at a time, with scale locked. */
export function fitTextRules(
  samples: Sample[],
  profile: ResolvedModelProfile,
  initial: ResolvedModelProfile,
  options: Pick<TuneOptions, "signal">,
): ResolvedModelProfile {
  const text = resolveTextRules(profile.text);
  const start = resolveTextRules(initial.text);
  const active = ALL_TEXT_FIELDS.filter((field) =>
    samples.some((sample) => containsTextField(sample.text, field)),
  );

  function objective(): number {
    throwIfAborted(options.signal);
    let loss = 0;
    samples.forEach((sample) => {
      const estimate =
        profile.contentMultiplier * estimateHistogramTokens(sample.text, text);
      const error = (estimate - sample.actual) / Math.max(1, sample.actual);
      loss += error * error;
    });
    let penalty = 0;
    for (const field of active) {
      if (field === "shortTokenThreshold" || field === "lowercaseWordMaxLength")
        penalty +=
          10 *
          ((getTextValue(text, field) - getTextValue(start, field)) /
            Math.max(1, getTextValue(start, field))) **
            2;
      else
        penalty +=
          Math.log(getTextValue(text, field) / getTextValue(start, field)) ** 2;
    }
    return loss / samples.length + 1e-6 * penalty;
  }

  for (const field of active) {
    const current = getTextValue(text, field);
    let best = current;
    let bestLoss = objective();
    const candidates = listCandidateValues(
      field,
      samples.map((sample) => sample.text),
      text,
      getTextValue(start, field),
    );
    const evaluate = (value: number): number => {
      setTextValue(text, field, value);
      const loss = objective();
      if (loss < bestLoss - 1e-15) {
        best = value;
        bestLoss = loss;
      }
      return loss;
    };
    for (const candidate of candidates) evaluate(candidate);
    setTextValue(text, field, best);
  }
  return { ...profile, text };
}

export function reportTextFields(
  samples: Sample[],
  initial: ResolvedModelProfile,
  final: ResolvedModelProfile,
): FieldReport[] {
  const start = resolveTextRules(initial.text);
  const end = resolveTextRules(final.text);
  return ALL_TEXT_FIELDS.map((field) => {
    const supported = samples.some((sample) =>
      containsTextField(sample.text, field),
    );
    return {
      field: `text.${LANGUAGES.includes(field as (typeof LANGUAGES)[number]) ? `languageCharsPerToken.${field}` : field}`,
      initial: getTextValue(start, field),
      final: getTextValue(end, field),
      identifiable: supported,
      ...(!supported ? { reason: "absent" as const } : {}),
    };
  });
}
