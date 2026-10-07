import type { ToolSet } from "ai";
import { jsonSchema, tool } from "ai";
import { expect, it } from "vitest";
import type { UsageInput } from "../src/index.ts";
import {
  createUsageEstimator,
  estimateTokenCount,
  resolveProfile,
} from "../src/index.ts";
import { FEATURE_FIELDS, Feature } from "../src/profile.ts";
import { collectSamples } from "../src/tune/collect.ts";
import {
  buildHistogram,
  estimateHistogramTokens,
  resolveTextRules,
} from "../src/tune/text.ts";

it("counts distinct binary media requests separately", async () => {
  const samples: UsageInput[] = [1, 2].map((byte) => ({
    messages: [
      {
        role: "user",
        content: [{ type: "image", image: new Uint8Array([byte]).buffer }],
      },
    ],
  }));
  const result = await collectSamples(samples, resolveProfile(), {
    countTokens: () => 100,
  });
  expect(result.samples).toHaveLength(2);
  expect(result.counterCalls).toBe(2);
});

it("counts shared controls once per collection and uses fresh counts on the next run", async () => {
  const input: UsageInput = { messages: [{ role: "user", content: "Hello" }] };
  const equivalent: UsageInput = { messages: input.messages };
  let calls = 0;
  const options = { countTokens: () => ++calls };
  const one = await collectSamples(
    [input, equivalent],
    resolveProfile(),
    options,
  );
  const two = await collectSamples(
    [input, equivalent],
    resolveProfile(),
    options,
  );
  expect(one.inputIndices).toEqual([0, 0]);
  expect(one.counterCalls).toBe(1);
  expect(two.counterCalls).toBe(1);
  expect(calls).toBe(2);
});

it("limits concurrent ground-truth requests", async () => {
  const samples: UsageInput[] = ["a", "b", "c", "d"].map((content) => ({
    messages: [{ role: "user", content }],
  }));
  let running = 0;
  let maximum = 0;
  const result = await collectSamples(samples, resolveProfile(), {
    concurrency: 2,
    countTokens: async () => {
      maximum = Math.max(maximum, ++running);
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      running--;
      return 10;
    },
  });
  expect(maximum).toBe(2);
  expect(result.counterCalls).toBe(4);
});

it("aborts before counting and while waiting for a pending counter", async () => {
  const input: UsageInput = {
    messages: [{ role: "user", content: "Pending" }],
  };
  const stopped = new AbortController();
  stopped.abort(new Error("Stopped"));
  let calls = 0;
  await expect(
    collectSamples([input], resolveProfile(), {
      signal: stopped.signal,
      countTokens: () => ++calls,
    }),
  ).rejects.toThrow("Stopped");
  expect(calls).toBe(0);
  const controller = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const pending = collectSamples([input], resolveProfile(), {
    signal: controller.signal,
    countTokens: () => {
      started();
      return new Promise<number>(() => {});
    },
  });
  await ready;
  controller.abort(new Error("Stopped"));
  await expect(pending).rejects.toThrow("Stopped");
});

it("stops scheduling counts after a counter failure", async () => {
  const failure = new Error("Counter failed");
  const samples: UsageInput[] = ["a", "b"].map((content) => ({
    messages: [{ role: "user", content }],
  }));
  let calls = 0;
  await expect(
    collectSamples(samples, resolveProfile(), {
      concurrency: 1,
      countTokens: () => {
        calls++;
        throw failure;
      },
    }),
  ).rejects.toBe(failure);
  expect(calls).toBe(1);
});

it.each([NaN, Infinity, -1])(
  "rejects invalid ground-truth counts (%s)",
  async (value) => {
    await expect(
      collectSamples([{ messages: [] }], resolveProfile(), {
        countTokens: () => value,
      }),
    ).rejects.toThrow(TypeError);
  },
);

it("uses histograms that agree with text estimation across changed ratios and mixed scripts", () => {
  const texts = [
    "a ab abc abcd ABCDEFGHIJK 12345678",
    "--------\n \t word\n\n",
    "界かな한글 mixed界",
    "übergröße électricité łódź русский ελληνικά 😀👍🏽",
    "a\r\nword\u00A0word\u2028a\uFEFFb",
    '!?\\"[]{}/_😀™ABC',
  ];
  const profiles = [
    {},
    {
      defaultCharsPerToken: 2.2,
      punctuationCharsPerToken: 1.5,
      digitsPerToken: 5,
      shortTokenThreshold: 0,
      lowercaseWordMaxLength: 0,
    },
    {
      hanziCharsPerToken: 3,
      kanaCharsPerToken: 2,
      hangulCharsPerToken: 1,
      languageCharsPerToken: { german: 1.4, romance: 2, emoji: 0.4 },
    },
  ];
  for (const text of texts) {
    const histogram = buildHistogram(text);
    for (const profile of profiles)
      expect(
        estimateHistogramTokens(histogram, resolveTextRules(profile)),
      ).toBe(estimateTokenCount(text, profile));
  }
});

it("extracts repeated tool text even when several names share a tool object", async () => {
  const shared = tool({
    description: "Find internationalization documents",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        query: { type: "string", description: "Internationalization query" },
      },
    }),
  });
  const input: UsageInput = {
    messages: [{ role: "user", content: "Internationalization" }],
    tools: { first: shared, second: shared } as ToolSet,
  };
  const extracted = await collectSamples([input], resolveProfile(), {
    countTokens: () => 0,
  });
  const text = resolveTextRules({ defaultCharsPerToken: 2 });
  const sample = extracted.samples[0]!;
  const textTokens = estimateHistogramTokens(sample.text, text);
  const profile = resolveProfile({ text, contentMultiplier: 1.3 });
  const total =
    FEATURE_FIELDS.reduce(
      (sum, field, index) => sum + sample.tally[index]! * profile[field],
      0,
    ) +
    textTokens * profile.contentMultiplier;
  expect(Math.round(total)).toBe(createUsageEstimator(profile).count(input));
  expect(sample.tally[Feature.perDesc]).toBe(2);
});
