import { expect, it } from "vitest";
import type { UsageInput } from "../src/index.ts";
import { createUsageEstimator } from "../src/index.ts";
import { LANGUAGE_DOCUMENTS } from "../src/tune/corpus/languages.ts";
import { TEXT_SELECTION_DOCUMENTS } from "../src/tune/corpus/selection.ts";
import { tuningCorpus } from "../src/tune/corpus.ts";
import { createProbes } from "../src/tune/probes.ts";
import { resolveJsonSchema } from "../src/usage/schema.ts";
import { BENCHMARK_SAMPLES, readSampleText } from "./fixtures/samples.ts";

it("builds the same inputs the live tuning built from the benchmark texts", async () => {
  const calibration: string[] = [];
  const validation: string[] = [];
  for (const sample of BENCHMARK_SAMPLES) {
    const text = [...(await readSampleText(sample))];
    for (const start of [0, 2_048])
      calibration.push(text.slice(start, start + 2_048).join(""));
    for (const start of [4_096, 6_144])
      validation.push(text.slice(start, start + 2_048).join(""));
  }
  const plain = (input: UsageInput): unknown => ({
    ...input,
    tools:
      input.tools &&
      Object.fromEntries(
        Object.entries(input.tools).map(([name, tool]) => [
          name,
          {
            description: tool.description,
            schema: resolveJsonSchema(tool.inputSchema),
          },
        ]),
      ),
  });
  expect(tuningCorpus.probes).toEqual(
    createProbes({
      texts: calibration.filter(Boolean),
      lengths: [128, 512, 2048],
    }),
  );
  expect(
    tuningCorpus.textSamples.map((input) => input.messages[0]!.content),
  ).toEqual(
    [
      ...calibration.filter(Boolean),
      ...LANGUAGE_DOCUMENTS.map((document) => document.text),
    ].flatMap((text) => [...new Set([text, [...text].slice(0, 512).join("")])]),
  );
  expect(
    tuningCorpus.textSelectionSamples.map(
      (input) => input.messages[0]!.content,
    ),
  ).toEqual(
    TEXT_SELECTION_DOCUMENTS.flatMap((document) => [
      ...new Set([document.text, [...document.text].slice(0, 256).join("")]),
    ]),
  );
  expect(tuningCorpus.validationSamples).toHaveLength(
    validation.filter(Boolean).length * 3,
  );
  expect(
    tuningCorpus.validationSamples
      .filter((_, n) => n % 3 === 0)
      .map((input) => input.messages[0]!.content),
  ).toEqual(validation.filter(Boolean));
  expect(plain(tuningCorpus.validationSamples[1]!)).toMatchObject({
    tools: {
      search_catalog: { schema: { type: "object", required: ["query"] } },
    },
  });
  expect(Object.isFrozen(tuningCorpus)).toBe(true);
});

it("tunes on the built-in corpus without being given inputs", async () => {
  const { tuneProfile } = await import("../src/tune/index.ts");
  const target = createUsageEstimator({ perMessage: 7 });
  const result = await tuneProfile({
    countTokens: (input) => target.count(input),
  });
  // Only the corpus supplies natural text, selection documents, and validation requests.
  expect(result.report.text.composition).not.toBeNull();
  expect(result.report.validation?.after.count).toBe(
    tuningCorpus.validationSamples.length,
  );
  expect(result.profile.perMessage).toBe(7);
}, 60_000);
