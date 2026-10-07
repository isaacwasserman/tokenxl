import type { ErrorMetrics } from "./types.ts";

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
