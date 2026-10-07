import type { ResolvedModelProfile } from "../profile.ts";
import { compileProfile } from "../profile.ts";
import { tallyUsage } from "../usage/estimator.ts";
import type { UsageInput } from "../usage/types.ts";
import type { TextHistogram } from "./text.ts";
import {
  buildHistogram,
  createHistogram,
  estimateHistogramTokens,
  mergeHistogram,
  resolveTextRules,
} from "./text.ts";
import type { TokenUsage, TuneOptions } from "./types.ts";

export interface CollectionOptions
  extends Pick<TuneOptions, "countTokens" | "concurrency" | "signal"> {
  observations?: Map<UsageInput | string, Sample>;
  onProgress?: (event: {
    phase: "collect";
    completed: number;
    total: number;
  }) => void;
  /** Each counter call, with `performance.now()` times. */
  onCall?: (call: { start: number; end: number; usage?: TokenUsage }) => void;
}

export interface Sample {
  tally: Float64Array;
  text: TextHistogram;
  actual: number;
}

export interface Collected {
  samples: Sample[];
  /** Maps every original input, including duplicates, to its collected sample. */
  inputIndices: number[];
  counterCalls: number;
}

/** Also releases a waiting caller when its counter cannot itself be canceled. */
function rejectOnAbort<T>(
  value: PromiseLike<T> | T,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return Promise.resolve(value);
  return new Promise((resolve, reject) => {
    const aborted = (): void => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    Promise.resolve(value).then(
      (result) => {
        signal.removeEventListener("abort", aborted);
        resolve(result);
      },
      (error) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
  });
}

/** Plain text shares controls by content; structured controls share their object. */
function getRequestKey(input: UsageInput): UsageInput | string {
  const message = input.messages[0];
  return input.messages.length === 1 &&
    message?.role === "user" &&
    typeof message.content === "string" &&
    (!input.tools || !Object.keys(input.tools).length)
    ? message.content
    : input;
}

function assertValidCount(value: number): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new TypeError(
      "tokenx: Ground-truth token counts must be finite nonnegative numbers.",
    );
}

/**
 * Pairs each request's ground-truth count from `countTokens` with the
 * estimator's view of the same request: its feature totals and text histogram.
 */
export async function collectSamples(
  inputs: readonly UsageInput[],
  initial: ResolvedModelProfile,
  options: CollectionOptions,
): Promise<Collected> {
  const compiled = compileProfile(initial);
  const initialText = resolveTextRules(initial.text);
  const histograms = new Map<
    string,
    { histogram: TextHistogram; tokens: number }
  >();
  const unique = new Map<UsageInput | string, UsageInput>();
  const indices = new Map<UsageInput | string, number>();
  const inputIndices: number[] = [];
  for (const input of inputs) {
    options.signal?.throwIfAborted();
    const identity = getRequestKey(input);
    if (!unique.has(identity)) {
      indices.set(identity, unique.size);
      unique.set(identity, input);
    }
    inputIndices.push(indices.get(identity)!);
  }
  const requests = [...unique.entries()];
  const samples: Sample[] = Array.from({ length: requests.length });
  let completed = 0;
  let counterCalls = 0;
  const progress = (): void =>
    options.onProgress?.({
      phase: "collect",
      completed: ++completed,
      total: requests.length,
    });

  await mapConcurrent(
    requests,
    options.concurrency ?? 4,
    options.signal,
    async ([identity, input], index) => {
      const observed = options.observations?.get(identity);
      if (observed) {
        samples[index] = observed;
        progress();
        return;
      }
      const text = createHistogram();
      const tally = tallyUsage(input, compiled, {}, (content) => {
        let cached = histograms.get(content);
        if (!cached) {
          const histogram = buildHistogram(content);
          cached = {
            histogram,
            tokens: estimateHistogramTokens(histogram, initialText),
          };
          histograms.set(content, cached);
        }
        mergeHistogram(text, cached.histogram);
        return cached.tokens;
      });
      counterCalls++;
      const start = performance.now();
      const result = await rejectOnAbort(
        Promise.resolve().then(() => options.countTokens(input)),
        options.signal,
      );
      const actual = typeof result === "number" ? result : result?.count;
      options.onCall?.({
        start,
        end: performance.now(),
        ...(typeof result === "object" && result?.usage
          ? { usage: result.usage }
          : {}),
      });
      assertValidCount(actual);
      options.signal?.throwIfAborted();
      samples[index] = { tally, text, actual };
      options.observations?.set(identity, samples[index]!);
      progress();
    },
  );
  return { samples, inputIndices, counterCalls };
}

/**
 * Runs `run` on each item, at most `limit` at a time. The first error stops
 * scheduling new items and rejects; an abort rejects before the next item.
 */
export async function mapConcurrent<T>(
  items: readonly T[],
  limit: number,
  signal: AbortSignal | undefined,
  run: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  let failed = false;
  async function worker(): Promise<void> {
    while (next < items.length && !failed) {
      signal?.throwIfAborted();
      const index = next++;
      try {
        await run(items[index]!, index);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
}
