// Tunes a model through its provider and prints its registry entry; --write adds it to src/profiles.json.
//
//   pnpm tune --provider <anthropic|openai|openrouter> --model <id> [--write] [--profile] [--no-reasoning]
//
// Reasoning costs come from up to 10 billed responses at high effort. The costs
// do not depend on the reasoning level, so the script turns reasoning up to
// make sure the model reasons. A model that OpenRouter's public list shows
// without effort levels keeps the reasoning costs it already has; so does
// every model with --no-reasoning, which generates nothing. The script
// writes no files except
// src/profiles.json with --write. With --profile, it prints the time and the
// spend at OpenRouter's list prices of each phase.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { DEFAULT_TEXT_PROFILE } from "../src/index.ts";
import type { ModelProfile } from "../src/profile.ts";
import type { ProviderName } from "../src/provider-adapters/index.ts";
import {
  createProviderAdapter,
  getModelKey,
  PROVIDER_NAMES,
} from "../src/provider-adapters/index.ts";
import type { TokenUsage, TuneCall, TuneReport } from "../src/tune/index.ts";
import { tuneProfile } from "../src/tune/index.ts";

const root = resolve(import.meta.dirname, "..");
const registryPath = resolve(root, "src/profiles.json");
function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

const { values } = parseArgs({
  options: {
    provider: { type: "string" },
    model: { type: "string" },
    write: { type: "boolean", default: false },
    concurrency: { type: "string", default: "16" },
    profile: { type: "boolean", default: false },
    reasoning: { type: "boolean", default: true },
  },
  allowNegative: true,
  strict: true,
});
const provider = values.provider as ProviderName | undefined;
const modelId = values.model;
if (!provider || !PROVIDER_NAMES.includes(provider) || !modelId) {
  log(
    `Usage: pnpm tune --provider <${PROVIDER_NAMES.join("|")}> --model <id> [--write] [--profile] [--no-reasoning]`,
  );
  process.exit(2);
}
const apiKey = process.env[`${provider.toUpperCase()}_API_KEY`]?.trim();
if (!apiKey) {
  log(`Set ${provider.toUpperCase()}_API_KEY in .env or the environment.`);
  process.exit(2);
}

const key = getModelKey(provider, modelId);
const registry: Record<string, ModelProfile> = JSON.parse(
  readFileSync(registryPath, "utf8"),
);
const existing = registry[key];
const REASONING_FIELDS = [
  "perReasoningPayloadChar",
  "reasoningPayloadEnvelopeChars",
  "countReasoningInPreviousTurns",
  "perStoredReasoning",
  "storedReasoningSummaryScale",
] as const;
// The image probes are smaller than every resize limit, so the limits are not measured.
const IMAGE_LIMIT_FIELDS = [
  "imageMaxEdge",
  "imageMaxShortEdge",
  "imageMaxPatches",
] as const;

try {
  // Models without effort levels cannot be asked to reason through the adapters.
  const listed = values.reasoning
    ? await fetchListedModel(key).catch(() => undefined)
    : undefined;
  const measureReasoning =
    values.reasoning &&
    (!listed || Boolean(listed.reasoning?.supported_efforts?.length));
  const { invokeModel, ...counting } = createProviderAdapter(provider, {
    apiKey,
    modelId,
    reasoningLevel: "high",
  });
  log(
    measureReasoning
      ? `Tuning ${key} through ${provider}, generating at high effort.`
      : `Tuning ${key} through ${provider}. ${values.reasoning ? "OpenRouter lists no effort levels for it, so its" : "Its"} reasoning costs are kept, not measured.`,
  );
  const result = await tuneProfile({
    ...counting,
    ...(measureReasoning ? { invokeModel } : {}),
    concurrency: Number(values.concurrency),
    onProgress: (event) => {
      if (event.phase === "fit" || event.completed === event.total)
        log(
          `  ${event.stage}: ${event.phase === "fit" ? "fitted" : `${event.phase} ${event.total}`}`,
        );
    },
  });
  const { report } = result;
  if (values.profile) await printProfile(report.timing);
  log(
    `  text rules: ${report.text.composition?.selected === "initial" ? "default" : "tuned"}`,
  );
  if (report.validation)
    log(
      `  validation mean error: ${report.validation.before.mape.toFixed(2)}% before, ${report.validation.after.mape.toFixed(2)}% after`,
    );

  const reason = report.reasoning?.reason;
  if (reason === "absent")
    throw new Error("The model did not reason at high effort.");
  if (reason)
    throw new Error(`The reasoning costs could not be fitted (${reason}).`);
  const { text, ...costs } = result.profile;
  const entry: ModelProfile =
    JSON.stringify(text) === JSON.stringify(DEFAULT_TEXT_PROFILE)
      ? costs
      : { ...costs, text };
  for (const field of IMAGE_LIMIT_FIELDS)
    if (existing?.[field] !== undefined) entry[field] = existing[field];
  if (!report.reasoning) {
    // Unmeasured reasoning costs keep their earlier values; without any, the defaults apply.
    for (const field of REASONING_FIELDS) {
      if (existing?.[field] === undefined) delete entry[field];
      else (entry as Record<string, unknown>)[field] = existing[field];
    }
  }
  process.stdout.write(`${JSON.stringify({ [key]: entry }, null, 2)}\n`);
  if (values.write) {
    if (existing) {
      const fields = new Set([...Object.keys(existing), ...Object.keys(entry)]);
      const changed = [...fields].filter(
        (field) =>
          JSON.stringify(existing[field as keyof ModelProfile]) !==
          JSON.stringify(entry[field as keyof ModelProfile]),
      );
      log(`Replacing ${key}; changed: ${changed.join(", ") || "nothing"}.`);
    }
    registry[key] = entry;
    const sorted = Object.fromEntries(
      Object.keys(registry)
        .sort()
        .map((name) => [name, registry[name]]),
    );
    writeFileSync(registryPath, `${JSON.stringify(sorted, null, 2)}\n`);
    log(`Wrote ${key} to src/profiles.json.`);
  }
} catch (error) {
  log(String(error instanceof Error ? error.message : error));
  process.exitCode = 1;
}

interface Price {
  prompt: string;
  completion: string;
  overrides?: {
    min_prompt_tokens: number;
    prompt: string;
    completion: string;
  }[];
}
interface ListedModel {
  pricing?: Price;
  reasoning?: { supported_efforts?: string[] };
}

/** The entry for a registry key in OpenRouter's public model list, which uses the same keys. */
async function fetchListedModel(key: string): Promise<ListedModel | undefined> {
  const response = await fetch("https://openrouter.ai/api/v1/models", {
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok)
    throw new Error(`OpenRouter models HTTP ${response.status}`);
  const { data } = (await response.json()) as {
    data: (ListedModel & { id: string })[];
  };
  return data.find((model) => model.id === key);
}

/** Prints the time, calls, billed tokens, and cost of each phase. */
async function printProfile(timing: TuneReport["timing"]): Promise<void> {
  const price = (await fetchListedModel(key).catch(() => undefined))?.pricing;
  // A request with many input tokens can have a higher price tier.
  const cost = (usage: TokenUsage): number => {
    const tier =
      price?.overrides?.findLast(
        (override) => usage.inputTokens >= override.min_prompt_tokens,
      ) ?? price;
    return tier
      ? usage.inputTokens * Number(tier.prompt) +
          usage.outputTokens * Number(tier.completion)
      : Number.NaN;
  };
  const dollars = (value: number): string =>
    Number.isNaN(value) ? "unknown" : `$${value.toFixed(value < 1 ? 4 : 2)}`;
  const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
  const columns = (calls: TuneCall[], start: number, end: number): string[] => {
    const billed = calls.flatMap((call) => (call.usage ? [call.usage] : []));
    return [
      seconds(end - start),
      `${((100 * (end - start)) / timing.total).toFixed(1)}%`,
      String(calls.length),
      // The mean number of calls in flight; near 0 means local computation.
      end > start
        ? (
            calls.reduce((sum, call) => sum + call.end - call.start, 0) /
            (end - start)
          ).toFixed(1)
        : "0.0",
      String(billed.length),
      String(billed.reduce((sum, usage) => sum + usage.inputTokens, 0)),
      String(billed.reduce((sum, usage) => sum + usage.outputTokens, 0)),
      dollars(billed.reduce((sum, usage) => sum + cost(usage), 0)),
    ];
  };
  const rows = timing.phases.map((phase) => [
    `${phase.stage} ${phase.phase}`,
    ...columns(
      timing.calls.filter(
        (call) =>
          call.stage === phase.stage &&
          call.start >= phase.start &&
          call.end <= phase.end,
      ),
      phase.start,
      phase.end,
    ),
  ]);
  const table = [
    [
      "Phase",
      "Time",
      "Share",
      "Calls",
      "In flight",
      "Billed",
      "Input tokens",
      "Output tokens",
      "Cost",
    ],
    ...rows,
    ["Total", ...columns(timing.calls, 0, timing.total)],
  ];
  const widths = table[0]!.map((_, column) =>
    Math.max(...table.map((row) => row[column]!.length)),
  );
  const perMillion = (value: string | undefined): string =>
    value === undefined ? "unknown" : `$${(Number(value) * 1e6).toFixed(2)}`;
  log(
    `\nProfile (list prices: ${perMillion(price?.prompt)} per million input tokens, ${perMillion(price?.completion)} per million output tokens):`,
  );
  log(
    table
      .map((row) =>
        row
          .map((cell, column) =>
            column
              ? cell.padStart(widths[column]!)
              : cell.padEnd(widths[column]!),
          )
          .join("  "),
      )
      .join("\n"),
  );
  for (const kind of ["count", "generate"] as const) {
    const latencies = timing.calls
      .filter((call) => call.kind === kind)
      .map((call) => call.end - call.start)
      .sort((a, b) => a - b);
    if (latencies.length)
      log(
        `${kind === "count" ? "Counter" : "Model"} calls: p50 ${seconds(latencies[Math.floor(latencies.length / 2)]!)}, p90 ${seconds(latencies[Math.floor(latencies.length * 0.9)]!)}, max ${seconds(latencies.at(-1)!)}`,
      );
  }
}
