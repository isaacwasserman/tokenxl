import type { ResolvedModelProfile } from "../profile.ts";
import { compileProfile, Feature } from "../profile.ts";
import { listCandidateValues } from "./candidates.ts";
import type { Sample } from "./collect.ts";

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
    options.signal?.throwIfAborted();
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

/**
 * Least squares by rank-revealing QR. A column that is all zero (`absent`) or
 * a combination of earlier columns (`collinear`) gets no coefficient.
 */
export function solveLeastSquares(
  rows: readonly number[][],
  targets: readonly number[],
  signal?: AbortSignal,
): {
  coefficients: (number | undefined)[];
  reasons: Map<number, "absent" | "collinear">;
} {
  const columns = rows[0]?.length ?? 0;
  const basis: number[][] = [];
  const triangular: number[][] = [];
  const active: { index: number; norm: number }[] = [];
  const reasons = new Map<number, "absent" | "collinear">();
  for (let index = 0; index < columns; index++) {
    signal?.throwIfAborted();
    const column = rows.map((row) => row[index]!);
    const norm = Math.sqrt(
      column.reduce((sum, value) => sum + value * value, 0),
    );
    if (!norm) {
      reasons.set(index, "absent");
      continue;
    }
    for (let n = 0; n < column.length; n++) column[n]! /= norm;
    const projections = Array.from<number>({ length: basis.length }).fill(0);
    // Reorthogonalize to avoid inaccurate rank decisions for similar columns.
    for (let pass = 0; pass < 2; pass++) {
      basis.forEach((direction, k) => {
        const projection = direction.reduce(
          (sum, value, n) => sum + value * column[n]!,
          0,
        );
        projections[k]! += projection;
        for (let n = 0; n < column.length; n++)
          column[n]! -= projection * direction[n]!;
      });
    }
    const diagonal = Math.sqrt(
      column.reduce((sum, value) => sum + value * value, 0),
    );
    if (diagonal <= 1e-8) {
      reasons.set(index, "collinear");
      continue;
    }
    for (let n = 0; n < column.length; n++) column[n]! /= diagonal;
    for (let k = 0; k < basis.length; k++) triangular[k]!.push(projections[k]!);
    triangular.push([
      ...Array.from<number>({ length: basis.length }).fill(0),
      diagonal,
    ]);
    basis.push(column);
    active.push({ index, norm });
  }
  const solved = basis.map((direction) =>
    direction.reduce((sum, value, n) => sum + value * targets[n]!, 0),
  );
  for (let k = active.length - 1; k >= 0; k--) {
    for (let j = k + 1; j < active.length; j++)
      solved[k]! -= triangular[k]![j]! * solved[j]!;
    solved[k]! /= triangular[k]![k]!;
  }
  const coefficients: (number | undefined)[] = Array.from({ length: columns });
  active.forEach(({ index, norm }, k) => {
    coefficients[index] = solved[k]! / norm;
  });
  return { coefficients, reasons };
}

export function summarizeErrors(
  cases: readonly { actual: number; estimated: number }[],
): ErrorMetrics {
  const errors = cases.map((row) => row.estimated - row.actual);
  const relative = errors.map(
    (error, n) => error / Math.max(1, cases[n]!.actual),
  );
  const sum = (values: number[]): number =>
    values.reduce((total, value) => total + value, 0);
  const count = cases.length;
  const divisor = count || 1;
  return {
    count,
    loss: sum(relative.map((error) => error ** 2)) / divisor,
    mae: sum(errors.map(Math.abs)) / divisor,
    mape: (sum(relative.map(Math.abs)) / divisor) * 100,
    meanError: (sum(relative) / divisor) * 100,
    maxError:
      relative.reduce(
        (maximum, error) => Math.max(maximum, Math.abs(error)),
        0,
      ) * 100,
    aggregateError:
      (sum(errors) /
        Math.max(
          1,
          cases.reduce((total, row) => total + row.actual, 0),
        )) *
      100,
  };
}
