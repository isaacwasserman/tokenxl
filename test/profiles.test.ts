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
import { removeReasoningPayloads } from "../src/tune/reasoning.ts";

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

it("uses the tuned overheads and default text rules for gpt-6.1-sol", () => {
  const input: UsageInput = {
    messages: [
      { role: "system", content: "Be brief." },
      { role: "user", content: "Hello world" },
    ],
  };
  expect(resolveProfile("openai/gpt-6.1-sol").text).toEqual(
    resolveProfile().text,
  );
  expect(
    estimateTokenCount("Größenordnung 123456789", {
      profile: "openai/gpt-6.1-sol",
    }),
  ).toBe(estimateTokenCount("Größenordnung 123456789"));
  expect(estimateUsage(input, { profile: "openai/gpt-6.1-sol" })).toBe(
    createUsageEstimator({ ...MODEL_PROFILES["openai/gpt-6.1-sol"] }).count(
      input,
    ),
  );
  expect(estimateUsage(input, { profile: "openai/gpt-6.1-sol" })).not.toBe(
    estimateUsage(input),
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

it("drops reasoning in previous turns for models that do not count it", () => {
  const reasoned: UsageInput = {
    messages: [
      { role: "user", content: "Find books." },
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "",
            providerOptions: {
              openai: {
                itemId: "rs_1",
                reasoningEncryptedContent: "x".repeat(4000),
              },
            },
          },
          { type: "text", text: "Found." },
        ],
      },
      { role: "user", content: "Continue." },
    ],
  };
  expect(MODEL_PROFILES["openai/gpt-5.1"].countReasoningInPreviousTurns).toBe(
    false,
  );
  expect(createUsageEstimator("openai/gpt-5.1").count(reasoned)).toBe(
    createUsageEstimator("openai/gpt-5.1").count(
      removeReasoningPayloads(reasoned),
    ),
  );
  expect(
    createUsageEstimator("openai/gpt-6.1-sol").count(reasoned),
  ).toBeGreaterThan(
    createUsageEstimator("openai/gpt-6.1-sol").count(
      removeReasoningPayloads(reasoned),
    ),
  );
});

it("has reasoning costs for every predefined model", () => {
  for (const [modelId, profile] of Object.entries(MODEL_PROFILES)) {
    expect(profile.perReasoningPayloadChar, modelId).toBeGreaterThan(0);
    expect(
      profile.reasoningPayloadEnvelopeChars,
      modelId,
    ).toBeGreaterThanOrEqual(0);
    expect(typeof profile.countReasoningInPreviousTurns, modelId).toBe(
      "boolean",
    );
  }
});
