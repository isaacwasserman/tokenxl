import type { ResolvedModelProfile } from "../profile.ts";
import { listCandidateValues } from "./candidates.ts";
import type { Sample } from "./collect.ts";
import { throwIfAborted } from "./collect.ts";
import type { ResolvedText, Rule, TextField } from "./text.ts";
import {
  ALL_TEXT_FIELDS,
  estimateHistogramTokens,
  getTextValue,
  LANGUAGES,
  resolveTextRules,
  setTextValue,
} from "./text.ts";
import type {
  TextCalibrationReport,
  TextRuleCalibrationReport,
} from "./types.ts";

export interface MeasuredTextProbe {
  field: TextField;
  before: Sample;
  after: Sample;
}

/** Measure scale, then only the parameters named by each probe family. */
export function calibrateText(
  anchors: Sample[],
  probes: MeasuredTextProbe[],
  initial: ResolvedModelProfile,
  signal?: AbortSignal,
): {
  profile: ResolvedModelProfile;
  report: Omit<
    TextCalibrationReport,
    "overheadTextSamples" | "composition" | "context"
  >;
} {
  const rules = resolveTextRules(initial.text);
  const scale = measureScale(anchors, rules);
  const families: TextField[][] = [
    ["defaultCharsPerToken"],
    // The same short-segment gate applies to words and punctuation. Measuring
    // it on words alone cannot resolve gates below the general word ratio.
    ["shortTokenThreshold", "punctuationCharsPerToken"],
    ["lowercaseWordMaxLength"],
    ...ALL_TEXT_FIELDS.filter(
      (field) =>
        ![
          "defaultCharsPerToken",
          "shortTokenThreshold",
          "punctuationCharsPerToken",
          "lowercaseWordMaxLength",
        ].includes(field),
    ).map((field) => [field]),
  ];
  const reports = families.flatMap((fields) =>
    fitProbeFamily(
      fields,
      probes.filter((probe) => fields.includes(probe.field)),
      rules,
      scale.multiplier,
      signal,
    ),
  );
  return {
    profile: { ...initial, contentMultiplier: scale.multiplier, text: rules },
    report: { ...scale, rules: reports },
  };
}

function fitProbeFamily(
  fields: TextField[],
  probes: MeasuredTextProbe[],
  rules: ResolvedText,
  multiplier: number,
  signal?: AbortSignal,
): TextRuleCalibrationReport[] {
  for (const probe of probes) assertIsolated(probe);
  const originals = fields.map((field) => getTextValue(rules, field));
  const candidates = fields.map((field, n) =>
    listCandidateValues(
      field,
      probes
        .filter((probe) => probe.field === field)
        .flatMap((probe) => [probe.before.text, probe.after.text]),
      { ...rules, shortTokenThreshold: 0, lowercaseWordMaxLength: 0 },
      originals[n]!,
    ),
  );
  const predictions = (): number[] =>
    probes.map(
      (probe) =>
        multiplier *
        (estimateHistogramTokens(probe.after.text, rules) -
          estimateHistogramTokens(probe.before.text, rules)),
    );
  const before = predictions();
  const loss = (predicted: number[]): number =>
    predicted.reduce(
      (sum, value, n) =>
        sum +
        (value - (probes[n]!.after.actual - probes[n]!.before.actual)) ** 2,
      0,
    );
  let best = [...originals];
  let bestLoss = loss(before);
  let bestDistance = 0;
  const values = [...originals];
  const distance = (): number =>
    fields.reduce(
      (sum, field, n) =>
        sum + ((values[n]! - originals[n]!) / Math.max(1, originals[n]!)) ** 2,
      0,
    );
  const search = (index: number): void => {
    throwIfAborted(signal);
    if (index < fields.length) {
      for (const candidate of candidates[index]!) {
        values[index] = candidate;
        setTextValue(rules, fields[index]!, candidate);
        search(index + 1);
      }
      return;
    }
    const candidateLoss = loss(predictions());
    const candidateDistance = distance();
    if (
      candidateLoss < bestLoss - 1e-9 ||
      (Math.abs(candidateLoss - bestLoss) <= 1e-9 &&
        candidateDistance < bestDistance)
    ) {
      best = [...values];
      bestLoss = candidateLoss;
      bestDistance = candidateDistance;
    }
  };
  search(0);
  fields.forEach((field, n) => {
    setTextValue(rules, field, best[n]!);
  });
  const after = predictions();
  const reports = fields.map((field, n): TextRuleCalibrationReport => {
    const indices = probes.flatMap((probe, k) =>
      probe.field === field ? [k] : [],
    );
    let identifiable = false;
    for (const candidate of candidates[n]!) {
      setTextValue(rules, field, candidate);
      if (predictions().some((value, k) => Math.abs(value - after[k]!) > 1e-9))
        identifiable = true;
    }
    setTextValue(rules, field, best[n]!);
    const rmse = (predicted: number[]): number =>
      indices.length
        ? Math.sqrt(
            indices.reduce(
              (sum, k) =>
                sum +
                (predicted[k]! -
                  (probes[k]!.after.actual - probes[k]!.before.actual)) **
                  2,
              0,
            ) / indices.length,
          )
        : 0;
    return {
      field:
        `text.${LANGUAGES.includes(field as (typeof LANGUAGES)[number]) ? `languageCharsPerToken.${field}` : field}` as TextRuleCalibrationReport["field"],
      initial: originals[n]!,
      final: best[n]!,
      identifiable,
      ...(!identifiable
        ? {
            reason: indices.length
              ? ("collinear" as const)
              : ("absent" as const),
          }
        : {}),
      probes: indices.length,
      beforeRmse: rmse(before),
      afterRmse: rmse(after),
      ...(fields.length > 1
        ? { coupledWith: fields.filter((other) => other !== field) }
        : {}),
    };
  });
  return reports;
}

/** Centered y = multiplier * x + intercept; unit-word anchors fix scale. */
function measureScale(
  samples: Sample[],
  rules: ResolvedText,
): Omit<
  TextCalibrationReport,
  "rules" | "overheadTextSamples" | "composition" | "context"
> {
  const x = samples.map((sample) => {
    const entries = [...sample.text.rules.values()];
    if (
      entries.length &&
      entries.every(
        (entry) => entry.rule.kind === "word" && entry.rule.length === 1,
      )
    )
      return (
        sample.text.fixed + entries.reduce((sum, entry) => sum + entry.count, 0)
      );
    return estimateHistogramTokens(sample.text, rules);
  });
  const count = samples.length;
  const meanX = x.reduce((sum, value) => sum + value, 0) / count;
  const meanY = samples.reduce((sum, sample) => sum + sample.actual, 0) / count;
  let xx = 0;
  let xy = 0;
  let yy = 0;
  samples.forEach((sample, n) => {
    const dx = x[n]! - meanX;
    const dy = sample.actual - meanY;
    xx += dx * dx;
    xy += dx * dy;
    yy += dy * dy;
  });
  if (!Number.isFinite(xx) || xx <= 0)
    throw new RangeError(
      "tokenx: Text anchors must vary in estimated tokens to separate scale from overhead.",
    );
  const multiplier = xy / xx;
  if (!Number.isFinite(multiplier) || multiplier <= 0)
    throw new RangeError(
      "tokenx: Text calibration did not yield a finite positive multiplier.",
    );
  const intercept = meanY - multiplier * meanX;
  const squaredError = samples.reduce(
    (sum, sample, n) =>
      sum + (sample.actual - (multiplier * x[n]! + intercept)) ** 2,
    0,
  );
  return {
    samples: count,
    multiplierSamples: count,
    multiplier,
    intercept,
    rmse: Math.sqrt(squaredError / count),
    rSquared: yy > 0 ? 1 - squaredError / yy : 0,
  };
}

/** Reject mislabeled experiments rather than letting other rules compensate. */
function assertIsolated(probe: MeasuredTextProbe): void {
  const changes = new Map<string, { rule: Rule; count: number }>();
  for (const [key, entry] of probe.after.text.rules)
    changes.set(key, { rule: entry.rule, count: entry.count });
  for (const [key, entry] of probe.before.text.rules) {
    const changed = changes.get(key);
    changes.set(key, {
      rule: entry.rule,
      count: (changed?.count ?? 0) - entry.count,
    });
  }
  for (const { rule, count } of changes.values()) {
    if (!count || (rule.kind === "word" && rule.length === 1)) continue;
    if (!isRuleIsolated(rule, probe.field))
      throw new TypeError(
        `tokenx: The ${probe.field} probe changes an unrelated or not-yet-measured text rule.`,
      );
  }
}

function isRuleIsolated(rule: Rule, field: TextField): boolean {
  switch (rule.kind) {
    case "word":
      if (field === "defaultCharsPerToken")
        return !rule.lowercase && rule.length > 16;
      if (field === "shortTokenThreshold")
        return !rule.lowercase && rule.length <= 16;
      return field === "lowercaseWordMaxLength" && rule.lowercase;
    case "digits":
      return field === "digitsPerToken";
    case "punctuation":
      return field === "punctuationCharsPerToken";
    case "language":
      return field === rule.language;
    case "cjk":
      return (
        (field === "hanziCharsPerToken" &&
          rule.kana === 0 &&
          rule.hangul === 0) ||
        (field === "kanaCharsPerToken" &&
          rule.hanzi === 0 &&
          rule.hangul === 0) ||
        (field === "hangulCharsPerToken" && rule.hanzi === 0 && rule.kana === 0)
      );
  }
}
