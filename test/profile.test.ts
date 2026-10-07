import type { ModelMessage, ToolSet } from "ai";
import { jsonSchema, tool } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ModelProfile, ProfileField, UsageInput } from "../src/index";
import {
  createUsageEstimator,
  DEFAULT_PROFILE,
  estimateTokenCount,
  resolveProfile,
} from "../src/index";
import { DEFAULT_TEXT_PROFILE } from "../src/index.ts";
import { ZERO_COSTS } from "./fixtures/profile-fields.ts";

const STEP = 1000;

/**
 * How often the walker counts a field for an input: the change in the
 * estimate when the field grows by `STEP`, divided by `STEP`.
 */
function countFeature(
  input: UsageInput,
  field: ProfileField,
  profile: ModelProfile = {},
): number {
  const base = resolveProfile(profile);
  const before = createUsageEstimator(base).count(input);
  const after = createUsageEstimator({
    ...base,
    [field]: base[field] + STEP,
  }).count(input);
  return (after - before) / STEP;
}

const textMessage = (
  role: "user" | "assistant",
  text: string,
): ModelMessage => ({ role, content: [{ type: "text", text }] });

describe("resolveProfile", () => {
  it("fills missing fields with the defaults", () => {
    const profile = resolveProfile({ perMessage: 9 });
    expect(profile.perMessage).toBe(9);
    expect(profile.toolsExist).toBe(DEFAULT_PROFILE.toolsExist);
    expect(profile.text).toEqual(DEFAULT_TEXT_PROFILE);
  });

  it("ignores undefined fields", () => {
    expect(resolveProfile({ perMessage: undefined }).perMessage).toBe(
      DEFAULT_PROFILE.perMessage,
    );
  });

  it("fills missing text rules with the defaults, without sharing objects", () => {
    const text = {
      defaultCharsPerToken: 3,
      languageCharsPerToken: { german: 2 },
    };
    const profile = resolveProfile({ text });
    expect(profile.text).toEqual({
      ...DEFAULT_TEXT_PROFILE,
      defaultCharsPerToken: 3,
      languageCharsPerToken: {
        ...DEFAULT_TEXT_PROFILE.languageCharsPerToken,
        german: 2,
      },
    });
    expect(profile.text.languageCharsPerToken).not.toBe(
      text.languageCharsPerToken,
    );
  });

  it("freezes the defaults", () => {
    expect(Object.isFrozen(DEFAULT_PROFILE)).toBe(true);
  });

  it("exposes the resolved profile on the estimator", () => {
    expect(createUsageEstimator({ perTool: 1 }).profile).toEqual(
      resolveProfile({ perTool: 1 }),
    );
  });
});

describe("profile fields", () => {
  it("counts schema keyword, type, cardinality and primitive-array costs at their owning nodes", () => {
    const tools = {
      a: tool({
        inputSchema: jsonSchema({
          type: "object",
          additionalProperties: false,
          required: ["flag", "status", "count"],
          properties: {
            flag: { type: "boolean" },
            status: { enum: ["a", "b", "c"] },
            count: { type: "integer" },
            items: {
              type: "array",
              items: { anyOf: [{ type: "boolean" }, { type: "null" }] },
            },
            config: {
              type: "object",
              additionalProperties: true,
              required: ["limit"],
              properties: { limit: { type: "integer" } },
            },
          },
        }),
      }),
    };
    const input: UsageInput = { messages: [], tools };
    for (const [field, count] of Object.entries({
      perEnumValue: 3,
      perRequired: 2,
      perRequiredProp: 4,
      perAdditionalProperties: 2,
      perInteger: 2,
      perBoolean: 2,
      perArrayOfPrimitives: 1,
    }))
      expect(countFeature(input, field as ProfileField), field).toBe(count);
  });

  it("charges keywords at repeated reference use sites and includes const only in the fixed enum cost", () => {
    const tools = {
      a: tool({
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            first: { $ref: "#/definitions/config" },
            second: { $ref: "#/definitions/config" },
            constant: { const: "fixed" },
          },
          definitions: {
            config: {
              type: "object",
              additionalProperties: false,
              required: ["enabled"],
              properties: { enabled: { type: ["boolean", "null"] } },
            },
          },
        }),
      }),
    };
    const input: UsageInput = { messages: [], tools };
    for (const field of [
      "perRequired",
      "perAdditionalProperties",
      "perBoolean",
    ] as const)
      expect(countFeature(input, field), field).toBe(2);
    expect(countFeature(input, "perEnum")).toBe(1);
    expect(countFeature(input, "perEnumValue")).toBe(0);
  });

  it("separates required-list framing from entry costs, including an empty list", () => {
    const input = (required: string[]): UsageInput => ({
      messages: [],
      tools: {
        a: tool({
          inputSchema: jsonSchema({
            type: "object",
            properties: { q: { type: "string" }, limit: { type: "number" } },
            required,
          }),
        }),
      },
    });
    for (const required of [[], ["q"], ["q", "limit"]]) {
      expect(countFeature(input(required), "perRequired")).toBe(1);
      expect(countFeature(input(required), "perRequiredProp")).toBe(
        required.length,
      );
    }
  });

  it("adds baseOverhead once for every request", () => {
    expect(countFeature({ messages: [] }, "baseOverhead")).toBe(1);
    expect(
      countFeature(
        { messages: [textMessage("user", "a"), textMessage("user", "b")] },
        "baseOverhead",
      ),
    ).toBe(1);
  });

  it("adds perMessage for each message", () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "Be brief." },
      textMessage("user", "Hi"),
      textMessage("assistant", "Hello"),
    ];
    expect(countFeature({ messages }, "perMessage")).toBe(3);
  });

  it("adds perSystem for each system message only", () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "Be brief." },
      { role: "system", content: "Use English." },
      textMessage("user", "Hi"),
    ];
    expect(countFeature({ messages }, "perSystem")).toBe(2);
  });

  it("adds toolsExist once when there is at least one tool", () => {
    expect(countFeature({ messages: [] }, "toolsExist")).toBe(0);
    expect(countFeature({ messages: [], tools: {} }, "toolsExist")).toBe(0);
    expect(
      countFeature(
        { messages: [], tools: { a: tool({ inputSchema: z.object({}) }) } },
        "toolsExist",
      ),
    ).toBe(1);
  });

  it("adds perTool for each tool after the first", () => {
    const tools: ToolSet = {
      a: tool({ inputSchema: z.object({}) }),
      b: tool({ inputSchema: z.object({}) }),
      c: tool({ inputSchema: z.object({}) }),
    };
    expect(countFeature({ messages: [], tools }, "perTool")).toBe(2);
  });

  it("adds perDesc for each tool with a description", () => {
    const tools: ToolSet = {
      a: tool({ description: "First tool", inputSchema: z.object({}) }),
      b: tool({ inputSchema: z.object({}) }),
      c: tool({ description: "Third tool", inputSchema: z.object({}) }),
    };
    expect(countFeature({ messages: [], tools }, "perDesc")).toBe(2);
  });

  it("adds perFirstProp and perAdditionalProp for each object level", () => {
    const tools: ToolSet = {
      a: tool({
        inputSchema: z.object({
          one: z.string(),
          two: z.number(),
          nested: z.object({
            three: z.string(),
            four: z.string(),
            five: z.string(),
          }),
        }),
      }),
    };
    expect(countFeature({ messages: [], tools }, "perFirstProp")).toBe(2);
    expect(countFeature({ messages: [], tools }, "perAdditionalProp")).toBe(4);
  });

  it("adds perPropDesc for each property with a description", () => {
    const tools: ToolSet = {
      a: tool({
        inputSchema: z.object({
          one: z.string().describe("First"),
          two: z.string(),
          three: z.string().describe("Third").optional(),
        }),
      }),
    };
    expect(countFeature({ messages: [], tools }, "perPropDesc")).toBe(2);
  });

  it("adds perEnum for enums and constants, also inside optional and nullable wrappers", () => {
    const tools: ToolSet = {
      a: tool({
        inputSchema: z.object({
          plain: z.enum(["a", "b"]),
          optional: z.enum(["c", "d"]).optional(),
          nullable: z.enum(["e", "f"]).nullable(),
          constant: z.literal("g"),
          text: z.string(),
        }),
      }),
    };
    expect(countFeature({ messages: [], tools }, "perEnum")).toBe(4);
  });

  it("adds perNestedObject for each object property, also inside a nullable wrapper", () => {
    const tools: ToolSet = {
      a: tool({
        inputSchema: z.object({
          plain: z.object({ x: z.string() }),
          nullable: z
            .object({ y: z.string(), deeper: z.object({ z: z.string() }) })
            .nullable(),
          list: z.array(z.object({ w: z.string() })),
        }),
      }),
    };
    expect(countFeature({ messages: [], tools }, "perNestedObject")).toBe(3);
  });

  it("adds perArrayOfObjects for each array of objects only", () => {
    const tools: ToolSet = {
      a: tool({
        inputSchema: z.object({
          objects: z.array(z.object({ id: z.string() })),
          strings: z.array(z.string()),
          nested: z.object({
            more: z.array(z.object({ id: z.string() })).optional(),
          }),
        }),
      }),
    };
    expect(countFeature({ messages: [], tools }, "perArrayOfObjects")).toBe(2);
  });

  it("adds perToolCall, perToolResult, perReasoning, perImage and perFile for each part", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [
          { type: "image", image: "data:image/png;base64,AAAA" },
          { type: "file", data: "AAAA", mediaType: "application/pdf" },
          { type: "file", data: "AAAA", mediaType: "application/pdf" },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "Think first." },
          {
            type: "tool-call",
            toolCallId: "1",
            toolName: "lookup",
            input: { q: "x" },
          },
          {
            type: "tool-call",
            toolCallId: "2",
            toolName: "lookup",
            input: { q: "y" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "1",
            toolName: "lookup",
            output: { type: "text", value: "found" },
          },
          {
            type: "tool-result",
            toolCallId: "2",
            toolName: "lookup",
            output: {
              type: "content",
              value: [
                { type: "image-data", data: "AAAA", mediaType: "image/png" },
                {
                  type: "file-data",
                  data: "AAAA",
                  mediaType: "application/pdf",
                },
              ],
            },
          },
        ],
      },
    ];
    expect(countFeature({ messages }, "perToolCall")).toBe(2);
    expect(countFeature({ messages }, "perToolResult")).toBe(2);
    expect(countFeature({ messages }, "perReasoning")).toBe(1);
    expect(countFeature({ messages }, "perImage")).toBe(2);
    expect(countFeature({ messages }, "perFile")).toBe(3);
  });

  it("scales all estimated text by contentMultiplier", () => {
    const text = "The quick brown fox jumps over the lazy dog.";
    const zero = resolveProfile({
      ...ZERO_COSTS,
      contentMultiplier: 1,
    });
    const input: UsageInput = { messages: [textMessage("user", text)] };

    expect(createUsageEstimator(zero).count(input)).toBe(
      estimateTokenCount(text),
    );
    expect(
      createUsageEstimator({ ...zero, contentMultiplier: 2 }).count(input),
    ).toBe(2 * estimateTokenCount(text));
  });

  it("applies the text ratios of the profile", () => {
    const text = "Internationalization considerations";
    const zero = ZERO_COSTS;
    const input: UsageInput = { messages: [textMessage("user", text)] };

    expect(
      createUsageEstimator({
        ...zero,
        text: { defaultCharsPerToken: 3 },
      }).count(input),
    ).toBe(estimateTokenCount(text, { defaultCharsPerToken: 3 }));
  });

  it("counts a plain JSON Schema like the same Zod schema", () => {
    const zodTools: ToolSet = {
      a: tool({
        description: "Find",
        inputSchema: z.object({
          q: z.string().describe("Query"),
          mode: z.enum(["x", "y"]),
        }),
      }),
    };
    const jsonTools: ToolSet = {
      a: tool({
        description: "Find",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            q: { type: "string", description: "Query" },
            mode: { type: "string", enum: ["x", "y"] },
          },
          required: ["q", "mode"],
        }),
      }),
    };
    const estimator = createUsageEstimator();
    expect(estimator.count({ messages: [], tools: zodTools })).toBe(
      estimator.count({ messages: [], tools: jsonTools }),
    );
  });
});
