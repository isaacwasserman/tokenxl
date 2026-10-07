import type { JSONSchema7, ModelMessage, ToolSet } from "ai";
import { jsonSchema, tool, zodSchema } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { UsageInput } from "../src/index";
import {
  createUsageEstimator,
  estimateTokenCount,
  estimateUsage,
} from "../src/index";
import { compileProfile, FEATURE_FIELDS } from "../src/profile";
import { tallyUsage } from "../src/usage/estimator";

// Structural overhead is zero so the expected counts expose the text and media rules.
const profile = {
  ...Object.fromEntries(FEATURE_FIELDS.map((field) => [field, 0])),
  perImage: 11,
  perFile: 17,
};
const estimator = createUsageEstimator(profile);
const textCount = (text: string): number => estimateTokenCount(text);

describe("message estimation", () => {
  it("keeps estimates correct when the bounded text cache fills or strings exceed its limit", () => {
    const cached = createUsageEstimator(profile);
    for (let index = 0; index < 300; index++) {
      const content = `A unique message number ${index} in the conversation.`;
      expect(cached.count({ messages: [{ role: "user", content }] })).toBe(
        textCount(content),
      );
    }
    const content = "Text beyond the short string cache. ".repeat(200);
    expect(cached.count({ messages: [{ role: "user", content }] })).toBe(
      textCount(content),
    );
    expect(cached.count({ messages: [{ role: "user", content }] })).toBe(
      textCount(content),
    );
    const input: UsageInput = {
      messages: [{ role: "user", content: "internationalization" }],
    };
    const first = createUsageEstimator({
      ...profile,
      text: { defaultCharsPerToken: 2 },
    }).count(input);
    const second = createUsageEstimator({
      ...profile,
      text: { defaultCharsPerToken: 10 },
    }).count(input);
    expect(first).toBeGreaterThan(second);
  });

  it("counts string content, reasoning, tool names and serialized inputs", () => {
    const input: UsageInput = {
      messages: [
        { role: "system", content: "Be brief." },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Looking up results." },
            { type: "reasoning", text: "Check the source." },
            {
              type: "tool-call",
              toolName: "search",
              toolCallId: "ignored",
              input: { q: "tokens" },
            },
          ],
        },
      ],
    };
    expect(estimator.count(input)).toBe(
      [
        "Be brief.",
        "Looking up results.",
        "Check the source.",
        "search",
        '{"q":"tokens"}',
      ].reduce((sum, text) => sum + textCount(text), 0),
    );
  });

  it.each(["text", "error-text", "json", "error-json"] as const)(
    "counts %s tool output",
    (type) => {
      const value = "Found results.";
      const input: UsageInput = {
        messages: [
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "1",
                toolName: "search",
                output: { type, value },
              },
            ],
          },
        ],
      };
      expect(estimator.count(input)).toBe(
        textCount(type.endsWith("json") ? JSON.stringify(value) : value),
      );
    },
  );

  it("counts media by their profile costs, without reading binary data", () => {
    const input: UsageInput = {
      messages: [
        {
          role: "user",
          content: [
            { type: "image", image: "a".repeat(10000) },
            {
              type: "file",
              data: "b".repeat(10000),
              mediaType: "application/pdf",
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "1",
              toolName: "search",
              output: {
                type: "content",
                value: [
                  { type: "text", text: "Results" },
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
      ],
    };
    expect(estimator.count(input)).toBe(2 * 11 + 2 * 17 + textCount("Results"));
  });

  it("handles AI SDK 7 generic image files and inline text documents", () => {
    const input: UsageInput = {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "file",
              mediaType: "image",
              data: { type: "data", data: "AAAA" },
            },
            {
              type: "file",
              mediaType: "text/plain",
              data: { type: "text", text: "Document text." },
            },
          ],
        },
        {
          role: "assistant",
          content: [
            {
              type: "reasoning-file",
              mediaType: "image/png",
              data: { type: "data", data: "AAAA" },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "1",
              toolName: "search",
              output: {
                type: "content",
                value: [
                  {
                    type: "file",
                    mediaType: "image/*",
                    data: {
                      type: "url",
                      url: new URL("https://example.com/image.png"),
                    },
                  },
                  {
                    type: "file",
                    mediaType: "text/plain",
                    data: { type: "text", text: "Tool text." },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    expect(estimator.count(input)).toBe(
      3 * 11 + 2 * 17 + textCount("Document text.") + textCount("Tool text."),
    );
  });

  it("records unknown parts as zero and reads execution-denied reasons", () => {
    const input = {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "future-part", text: "ignored" },
            {
              type: "tool-result",
              toolCallId: "1",
              toolName: "search",
              output: { type: "execution-denied", reason: "Access denied." },
            },
          ],
        },
      ],
    } as unknown as UsageInput;
    const breakdown = estimator.count(input, { breakdown: true });
    expect(breakdown.messages[0]!.parts[0]).toEqual({
      type: "future-part",
      total: 0,
    });
    expect(breakdown.total).toBe(textCount("Access denied."));
  });

  it("handles AI SDK 5 media outputs and fallback JSON output values", () => {
    const input = {
      messages: [
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              output: {
                type: "content",
                value: [
                  { type: "media", mediaType: "image/png", data: "AAAA" },
                  { type: "media", mediaType: "application/pdf", data: "AAAA" },
                ],
              },
            },
            {
              type: "tool-result",
              output: { type: "future-output", value: { count: 2 } },
            },
          ],
        },
      ],
    } as unknown as UsageInput;
    expect(estimator.count(input)).toBe(11 + 17 + textCount('{"count":2}'));
  });
});

describe("tool schema estimation", () => {
  const schema: JSONSchema7 = {
    type: "object",
    properties: {
      query: { type: "string", description: "Search text" },
      mode: { type: "string", enum: ["fast", "deep"] },
    },
    required: ["query", "mode"],
  };

  it("reads plain, AI SDK, Standard JSON Schema and converted schemas consistently", () => {
    const object = z.object({
      query: z.string().describe("Search text"),
      mode: z.enum(["fast", "deep"]),
    });
    const expected = estimator.count({
      messages: [],
      tools: { search: { inputSchema: schema } } as unknown as ToolSet,
    });
    for (const inputSchema of [
      jsonSchema(schema),
      zodSchema(object),
      object,
      () => jsonSchema(schema),
    ]) {
      expect(
        estimator.count({
          messages: [],
          tools: { search: { inputSchema } } as unknown as ToolSet,
        }),
      ).toBe(expected);
    }
    const hooked = createUsageEstimator(profile, {
      toJsonSchema: () => schema,
    });
    expect(
      hooked.count({
        messages: [],
        tools: {
          search: { inputSchema: { opaque: true } },
        } as unknown as ToolSet,
      }),
    ).toBe(expected);
  });

  it("counts unsupported schemas as name only", () => {
    expect(
      estimator.count({
        messages: [],
        tools: {
          search: { inputSchema: { opaque: true } },
        } as unknown as ToolSet,
      }),
    ).toBe(textCount("search"));
  });

  it.each([
    { jsonSchema: Promise.resolve(schema) },
    // biome-ignore lint/suspicious/noThenProperty: tests a thenable schema
    { jsonSchema: { then() {} } },
    { "~standard": { jsonSchema: { input: () => Promise.resolve(schema) } } },
    () => Promise.resolve(schema),
    Promise.resolve(schema),
  ])("rejects asynchronous schemas", (inputSchema) => {
    expect(() =>
      estimator.count({
        messages: [],
        tools: { search: { inputSchema } },
      } as unknown as UsageInput),
    ).toThrow(TypeError);
  });

  it("rejects asynchronous conversion hooks", () => {
    const hooked = createUsageEstimator(
      {},
      { toJsonSchema: (() => Promise.resolve(schema)) as never },
    );
    expect(() =>
      hooked.count({
        messages: [],
        tools: { search: { inputSchema: {} } },
      } as unknown as UsageInput),
    ).toThrow(TypeError);
  });

  it("resolves local references at each use, including escaped JSON Pointer keys", () => {
    const inline = {
      type: "object",
      properties: {
        child: { type: "object", properties: { kind: { enum: ["a", "b"] } } },
      },
    };
    const referenced = {
      type: "object",
      properties: { child: { $ref: "#/$defs/a~1b~0c" } },
      $defs: { "a/b~c": inline.properties.child },
    };
    const count = (inputSchema: unknown): number =>
      estimator.count({
        messages: [],
        tools: { search: { inputSchema } },
      } as unknown as UsageInput);
    expect(count(referenced)).toBe(count(inline));
  });

  it("stops recursive references and ignores unused definitions", () => {
    const tools = {
      search: {
        inputSchema: {
          type: "object",
          properties: { next: { $ref: "#/$defs/node" } },
          $defs: {
            node: {
              type: "object",
              properties: {
                value: { type: "string" },
                next: { $ref: "#/$defs/node" },
              },
            },
            unused: {
              type: "object",
              properties: { ignored: { type: "string" } },
            },
          },
        },
      },
    } as unknown as ToolSet;
    const result = estimator.count(
      { messages: [], tools },
      { breakdown: true },
    );
    expect(
      Object.keys(result.tools.definitions.search!.inputSchema.properties),
    ).toEqual(["next", "next.value", "next.next"]);
    expect(result.total).toBe(estimator.count({ messages: [], tools }));
  });

  it("counts enum branches in unions and nullable array items", () => {
    const tools = {
      search: {
        inputSchema: {
          type: "object",
          properties: {
            choice: { anyOf: [{ enum: ["a"] }, { const: "b" }] },
            list: {
              type: "array",
              items: {
                anyOf: [
                  { type: "object", properties: { id: { type: "string" } } },
                  { type: "null" },
                ],
              },
            },
          },
        },
      },
    } as unknown as ToolSet;
    const result = createUsageEstimator({
      ...profile,
      perEnum: 10,
      perArrayOfObjects: 20,
    }).count({ messages: [], tools }, { breakdown: true });
    expect(
      result.tools.definitions.search!.inputSchema.properties.choice!.enum,
    ).toBe(22);
    expect(
      result.tools.definitions.search!.inputSchema.properties.list!.nested,
    ).toBe(21);
  });

  it("applies array overhead to each object branch in array item unions", () => {
    const tools = {
      search: {
        inputSchema: {
          type: "object",
          properties: {
            list: {
              type: "array",
              items: {
                oneOf: [
                  { type: "object", properties: { id: { type: "string" } } },
                  { type: "object", properties: { slug: { type: "string" } } },
                ],
              },
            },
          },
        },
      },
    } as unknown as ToolSet;
    const custom = createUsageEstimator({
      ...profile,
      perArrayOfObjects: 20,
      perNestedObject: 100,
    });
    const result = custom.count({ messages: [], tools }, { breakdown: true });
    expect(
      result.tools.definitions.search!.inputSchema.properties.list!.nested,
    ).toBe(42);
  });

  it("caches tool schemas by default and reads them on every count with cache: false", () => {
    let reads = 0;
    const inputSchema = {
      get jsonSchema() {
        reads++;
        return schema;
      },
    };
    const shared = { inputSchema };
    const input = {
      messages: [],
      tools: { search: shared },
    } as unknown as UsageInput;
    const cached = createUsageEstimator(profile);
    const original = cached.count(input);
    cached.count(input);
    expect(reads).toBe(1);
    const breakdown = cached.count(input, { breakdown: true });
    cached.count(input, { breakdown: true });
    expect(reads).toBe(2);
    expect(breakdown.total).toBe(original);
    expect(
      cached.count({
        ...input,
        tools: { renamed: shared } as unknown as ToolSet,
      }),
    ).toBe(original - textCount("search") + textCount("renamed"));

    reads = 0;
    const uncached = createUsageEstimator(profile, { cache: false });
    expect(uncached.count(input)).toBe(original);
    expect(uncached.count(input, { breakdown: true })).toEqual(breakdown);
    expect(reads).toBe(2);
    expect(estimateUsage(input, { profile, cache: false })).toBe(original);
    expect(estimateTokenCount("Größenordnung naïve", { cache: false })).toBe(
      estimateTokenCount("Größenordnung naïve"),
    );
  });
});

it("keeps convenience estimation and the feature tally consistent across seeded requests", () => {
  let seed = 42;
  const random = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const compiled = compileProfile({
    contentMultiplier: 1.17,
    perMessage: 7.3,
    perSystem: 2,
    perTool: -1,
  });
  const custom = createUsageEstimator(compiled.profile);
  for (let index = 0; index < 100; index++) {
    const messages: ModelMessage[] = [{ role: "system", content: "Be brief." }];
    for (let n = 0, length = Math.floor(random() * 12); n < length; n++)
      messages.push({
        role: "user",
        content: "Hello 世界 1234! ".repeat(1 + Math.floor(random() * 10)),
      });
    const tools: ToolSet = {
      lookup: tool({
        inputSchema: z.object({
          id: z.string(),
          mode: z.enum(["a", "b"]).optional(),
        }),
      }),
    };
    const input = { messages, tools };
    const tally = tallyUsage(input, compiled);
    const expected = Math.round(
      tally.reduce((sum, count, i) => sum + count * compiled.weights[i]!, 0),
    );
    expect(custom.count(input)).toBe(expected);
    expect(estimateUsage(input, { profile: compiled.profile })).toBe(expected);
    expect(custom.count(input, { breakdown: true }).total).toBe(expected);
  }
});

it("passes a schema converter through estimateUsage", () => {
  const unreadable = { shape: "query" };
  const input: UsageInput = {
    messages: [{ role: "user", content: "Find books." }],
    tools: {
      search: { description: "Search.", inputSchema: unreadable } as never,
    },
  };
  const toJsonSchema = (): JSONSchema7 => ({
    type: "object",
    properties: { query: { type: "string", description: "Words to find." } },
  });
  const converted = createUsageEstimator(undefined, { toJsonSchema }).count(
    input,
  );
  expect(converted).toBeGreaterThan(estimateUsage(input));
  expect(estimateUsage(input, { toJsonSchema })).toBe(converted);
});
