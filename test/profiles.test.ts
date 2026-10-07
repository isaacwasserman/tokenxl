import { jsonSchema, tool } from "ai";
import { expect, it } from "vitest";
import type { ModelId, UsageInput } from "../src/index.ts";
import {
  createUsageEstimator,
  estimateTokenCount,
  estimateUsage,
  isWithinTokenLimit,
  MODEL_PROFILES,
  resolveProfile,
  sliceByTokens,
  splitByTokens,
} from "../src/index.ts";

it("uses the named profile for complete requests and breakdowns", () => {
  const input: UsageInput = {
    messages: [
      { role: "system", content: "Find matching records." },
      { role: "user", content: "Check catalog 123456789." },
    ],
    tools: {
      search: tool({
        description: "Search records.",
        inputSchema: jsonSchema({
          type: "object",
          properties: { query: { type: "string" }, limit: { type: "integer" } },
          required: ["query"],
          additionalProperties: false,
        }),
      }),
    },
  };
  const explicit = createUsageEstimator(
    MODEL_PROFILES["anthropic/claude-sonnet-5.5"],
  );
  const named = createUsageEstimator("anthropic/claude-sonnet-5.5");
  expect(named.count(input)).toBe(explicit.count(input));
  expect(named.count(input)).not.toBe(createUsageEstimator().count(input));
  expect(
    estimateUsage(input, {
      profile: "anthropic/claude-sonnet-5.5",
      breakdown: true,
    }),
  ).toEqual(explicit.count(input, { breakdown: true }));
  expect(resolveProfile("anthropic/claude-sonnet-5.5")).toEqual(
    resolveProfile(MODEL_PROFILES["anthropic/claude-sonnet-5.5"]),
  );
});

it("uses default profiles when omitted or explicitly undefined", () => {
  const input: UsageInput = {
    messages: [{ role: "user", content: "Hello world" }],
  };
  expect(createUsageEstimator().profile).toEqual(resolveProfile());
  expect(estimateUsage(input, { profile: undefined })).toBe(
    createUsageEstimator().count(input),
  );
  expect(estimateTokenCount("123456789", { profile: undefined })).toBe(3);
});

it("uses the named text rules in counts, limits, slices and chunks", () => {
  const options = { profile: "anthropic/claude-sonnet-5.5" } as const;
  const text = "123456789 123456789 123456789";
  // Derived from the profile, so a retune does not break the test.
  const word = estimateTokenCount("123456789", options);
  const total = estimateTokenCount(text, options);
  expect(total).not.toBe(estimateTokenCount(text));
  expect(isWithinTokenLimit(text, total, options)).toBe(true);
  expect(isWithinTokenLimit(text, total - 1, options)).toBe(false);
  expect(sliceByTokens(text, 0, word, options)).toBe("123456789");
  expect(sliceByTokens(text, -word, undefined, options)).toBe(" 123456789");
  expect(splitByTokens(text, word, options)).toEqual([
    "123456789",
    " 123456789",
    " 123456789",
  ]);
});

it("allows explicit text overrides while preserving the remaining model rules", () => {
  const options = {
    profile: "anthropic/claude-sonnet-5.5",
    languageCharsPerToken: { german: 13 },
    digitsPerToken: 9,
    defaultCharsPerToken: undefined,
  } as const;
  expect(estimateTokenCount("123456789", options)).toBe(1);
  expect(estimateTokenCount("Größenordnung", options)).toBe(1);
  expect(estimateTokenCount("κόσμος", options)).toBe(
    estimateTokenCount("κόσμος", { profile: "anthropic/claude-sonnet-5.5" }),
  );
  expect(
    estimateTokenCount("Größenordnung", {
      profile: "anthropic/claude-sonnet-5.5",
      languageCharsPerToken: { german: undefined },
    }),
  ).toBe(
    estimateTokenCount("Größenordnung", {
      profile: "anthropic/claude-sonnet-5.5",
    }),
  );
  expect(estimateTokenCount("Internationalization", options)).toBe(
    estimateTokenCount("Internationalization", {
      profile: "anthropic/claude-sonnet-5.5",
    }),
  );
});

it("applies a custom profile multiplier to text APIs without charging request overhead", () => {
  const options = {
    profile: { contentMultiplier: 2, baseOverhead: 1000, perMessage: 100 },
  };
  expect(estimateTokenCount("aa bb cc", options)).toBe(6);
  expect(isWithinTokenLimit("aa bb cc", 5, options)).toBe(false);
  expect(sliceByTokens("aa bb cc", 0, 2, options)).toBe("aa");
  expect(splitByTokens("aa bb cc", 2, options)).toEqual(["aa", " bb", " cc"]);
});

it("rejects unknown model IDs from JavaScript callers", () => {
  for (const profile of ["unknown-model", "toString", "__proto__"]) {
    const modelId = profile as ModelId;
    expect(() => createUsageEstimator(modelId)).toThrow(TypeError);
    expect(() => estimateUsage({ messages: [] }, { profile: modelId })).toThrow(
      TypeError,
    );
    expect(() => estimateTokenCount("Hello", { profile: modelId })).toThrow(
      TypeError,
    );
  }
});

it("keeps shared predefined profiles immutable at runtime", () => {
  const profile = MODEL_PROFILES["anthropic/claude-sonnet-5.5"];
  expect(Reflect.set(MODEL_PROFILES, "unknown-model", {})).toBe(false);
  expect(Reflect.set(profile, "perMessage", 100)).toBe(false);
  expect(Reflect.set(profile.text!, "digitsPerToken", 9)).toBe(false);
  expect(Reflect.set(profile.text!.languageCharsPerToken!, "german", 13)).toBe(
    false,
  );
});

it("charges encrypted reasoning by payload length and plain reasoning by its text", () => {
  const profile = {
    baseOverhead: 0,
    perMessage: 0,
    contentMultiplier: 3,
    perReasoning: 40,
    perReasoningPayloadChar: 2,
    reasoningPayloadEnvelopeChars: 2.5,
  };
  const input: UsageInput = {
    messages: [
      {
        role: "assistant",
        content: [
          { type: "text", text: "aa bb" },
          { type: "reasoning", text: "cc dd" },
          // The provider charges the hidden thinking, not the visible summary.
          {
            type: "reasoning",
            text: "A visible summary.",
            providerOptions: { anthropic: { signature: "opaque" } },
          },
          {
            type: "reasoning",
            text: "",
            providerOptions: {
              anthropic: { redactedData: "opaque-redacted-data" },
            },
          },
        ],
      },
    ],
  };
  const parts = [
    estimateTokenCount("aa bb") * 3,
    estimateTokenCount("cc dd") * 3 + 40,
    -5 + 2 * "opaque".length,
    -5 + 2 * "opaque-redacted-data".length,
  ];
  const expected = parts.reduce((sum, part) => sum + part, 0);
  expect(createUsageEstimator(profile).count(input)).toBe(expected);
  const breakdown = createUsageEstimator(profile).count(input, {
    breakdown: true,
  });
  expect(breakdown.total).toBe(expected);
  expect(breakdown.messages[0]!.parts.map((part) => part.total)).toEqual(parts);
});

it("drops reasoning in previous turns for profiles that do not count it", () => {
  const turns = (reasoning: boolean): UsageInput => ({
    messages: [
      { role: "user", content: "Find books." },
      {
        role: "assistant",
        content: [
          ...(reasoning
            ? [
                {
                  type: "reasoning" as const,
                  text: "",
                  providerOptions: {
                    openai: {
                      itemId: "rs_1",
                      reasoningEncryptedContent: "x".repeat(4000),
                    },
                  },
                },
              ]
            : []),
          { type: "text", text: "Found." },
        ],
      },
      { role: "user", content: "Continue." },
    ],
  });
  const drops = createUsageEstimator({ countReasoningInPreviousTurns: false });
  const counts = createUsageEstimator({ countReasoningInPreviousTurns: true });
  expect(drops.count(turns(true))).toBe(drops.count(turns(false)));
  expect(counts.count(turns(true))).toBeGreaterThan(counts.count(turns(false)));
});
