import type { JSONSchema7, ModelMessage, ToolSet } from "ai";
import { jsonSchema, tool, zodSchema } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { UsageInput } from "../src/index";
import { createUsageEstimator } from "../src/index";
import { ZERO_COSTS } from "./fixtures/profile-fields.ts";
import { countText } from "./fixtures/text.ts";

// Structural overhead is zero so the expected counts expose the text and media rules.
const profile = {
  ...ZERO_COSTS,
  perImage: 11,
  perFile: 17,
};
const estimator = createUsageEstimator(profile);
const textCount = (text: string): number => countText(text);

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
    expect(countText("Größenordnung naïve", { cache: false })).toBe(
      countText("Größenordnung naïve"),
    );
  });
});

it("counts the same with and without caching, and with a breakdown, across seeded requests", () => {
  let seed = 42;
  const random = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const profile = {
    contentMultiplier: 1.17,
    perMessage: 7.3,
    perSystem: 2,
    perTool: -1,
  };
  const custom = createUsageEstimator(profile);
  const uncached = createUsageEstimator(profile, { cache: false });
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
    const expected = custom.count(input);
    expect(uncached.count(input)).toBe(expected);
    expect(custom.count(input, { breakdown: true }).total).toBe(expected);
  }
});

it("reads unknown schemas through a schema converter", () => {
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
  expect(converted).toBeGreaterThan(createUsageEstimator().count(input));
});

const encrypted = {
  type: "reasoning.encrypted",
  data: "e".repeat(300),
  format: "openai-responses-v1",
};
const signed = {
  type: "reasoning.text",
  text: "Plan.",
  signature: "s".repeat(200),
  format: "anthropic-claude-v1",
};
const unsigned = {
  type: "reasoning.text",
  text: "Plan.",
  format: "anthropic-claude-v1",
};
const details = (
  list: unknown[],
): { openrouter: { reasoning_details: unknown[] } } => ({
  openrouter: { reasoning_details: list },
});

it("reads OpenRouter details from the message, the first tool call, or the first reasoning part, in that order", () => {
  // One token per payload character and nothing else, so the count is the payload length.
  const payloadEstimator = createUsageEstimator({
    ...ZERO_COSTS,
    contentMultiplier: 0,
    perReasoningPayloadChar: 1,
    reasoningPayloadEnvelopeChars: 0,
  });
  const lengths = (message: ModelMessage): number =>
    payloadEstimator.count({ messages: [message] });
  const parts = [
    { type: "reasoning", text: "Plan.", providerOptions: details([signed]) },
    {
      type: "tool-call",
      toolCallId: "call_1",
      toolName: "lookup",
      input: {},
      providerOptions: details([signed, encrypted]),
    },
  ];
  expect(lengths({ role: "assistant", content: parts } as ModelMessage)).toBe(
    500,
  );
  expect(
    lengths({ role: "assistant", content: parts.slice(0, 1) } as ModelMessage),
  ).toBe(200);
  expect(
    lengths({
      role: "assistant",
      content: parts,
      providerOptions: details([encrypted]),
    } as ModelMessage),
  ).toBe(300);
  // Unsigned Anthropic text details are dropped, as the provider does.
  expect(
    lengths({
      role: "assistant",
      content: [
        {
          type: "reasoning",
          text: "Plan.",
          providerOptions: details([unsigned, encrypted]),
        },
      ],
    } as ModelMessage),
  ).toBe(300);
  // An open model's unsigned text detail is sent as its text.
  expect(
    lengths({
      role: "assistant",
      content: [
        {
          type: "reasoning",
          text: "Open reasoning.",
          providerOptions: details([
            {
              type: "reasoning.text",
              text: "Open reasoning.",
              format: "unknown",
            },
          ]),
        },
      ],
    } as ModelMessage),
  ).toBe(15);
});

it("charges OpenRouter payloads once per request with the envelope formula, without the summary text", () => {
  const profile = {
    baseOverhead: 0,
    perMessage: 0,
    perToolCall: 0,
    perToolResult: 0,
    perReasoning: 40,
    perReasoningPayloadChar: 0.5,
    reasoningPayloadEnvelopeChars: 100,
  };
  const message = (text: string): ModelMessage =>
    ({
      role: "assistant",
      content: [
        {
          type: "reasoning",
          text: "A summary.",
          providerOptions: details([signed]),
        },
        { type: "text", text },
      ],
    }) as ModelMessage;
  const input: UsageInput = {
    messages: [message("First."), message("Second.")],
  };
  const text = countText("First.") + countText("Second.");
  // The same detail repeated in a later message is sent once.
  expect(createUsageEstimator(profile).count(input)).toBe(
    text + 0.5 * (200 - 100),
  );
});

const openaiHistory = (): UsageInput => ({
  messages: [
    { role: "user", content: "A question." },
    {
      role: "assistant",
      content: [
        ...["First idea.", "Second idea."].map((text) => ({
          type: "reasoning" as const,
          text,
          providerOptions: {
            openai: {
              itemId: "rs_1",
              reasoningEncryptedContent: "x".repeat(400),
            },
          },
        })),
        { type: "text" as const, text: "The answer." },
      ],
    },
    { role: "user", content: "Continue." },
  ],
});

it("charges each OpenAI reasoning item once by its payload, without summary text", () => {
  const profile = {
    baseOverhead: 0,
    perMessage: 0,
    perReasoning: 40,
    perReasoningPayloadChar: 0.5,
    reasoningPayloadEnvelopeChars: 10,
  };
  const answer =
    countText("The answer.") +
    countText("A question.") +
    countText("Continue.");
  expect(createUsageEstimator(profile).count(openaiHistory())).toBe(
    answer - 5 + 200,
  );
  const breakdown = createUsageEstimator(profile).count(openaiHistory(), {
    breakdown: true,
  });
  expect(breakdown.messages[1]!.parts.map((part) => part.total)).toEqual([
    195,
    0,
    countText("The answer."),
  ]);
  // Stored items have no payload: their summaries, scaled, estimate them.
  const stored: UsageInput = {
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "First idea.",
            providerOptions: { openai: { itemId: "rs_2" } },
          },
          {
            type: "reasoning",
            text: "Second idea.",
            providerOptions: { openai: { itemId: "rs_2" } },
          },
        ],
      },
    ],
  };
  const storedProfile = {
    ...profile,
    perStoredReasoning: 100,
    storedReasoningSummaryScale: 3,
  };
  expect(createUsageEstimator(storedProfile).count(stored)).toBe(
    3 * (countText("First idea.") + countText("Second idea.")),
  );
});

it("charges a stored OpenAI reasoning item without summary text its mean cost, once", () => {
  const profile = {
    baseOverhead: 0,
    perMessage: 0,
    perStoredReasoning: 100,
    storedReasoningSummaryScale: 3,
    countReasoningInPreviousTurns: false,
  };
  const empty = {
    type: "reasoning" as const,
    text: "",
    providerOptions: { openai: { itemId: "rs_3" } },
  };
  const turn = (role: "user" | "assistant"): UsageInput["messages"][number] =>
    role === "user"
      ? { role, content: "a" }
      : { role, content: [empty, { ...empty }] };
  const a = countText("a");
  expect(
    createUsageEstimator(profile).count({
      messages: [turn("user"), turn("assistant")],
    }),
  ).toBe(a + 100);
  // Before the last user message, a model that drops earlier reasoning charges nothing.
  expect(
    createUsageEstimator(profile).count({
      messages: [turn("user"), turn("assistant"), turn("user")],
    }),
  ).toBe(2 * a);
});

describe("text input", () => {
  const texts = [
    "",
    "What is the weather in Boston?",
    "Als Gregor Samsa eines Morgens aus unruhigen Träumen erwachte, fand er sich in seinem Bett verwandelt.",
    "猫（英语：cat）通常指家猫。 user_id = 42; 😀",
  ];

  it("counts a text like estimateTokenCount with the same profile", () => {
    for (const profile of [
      undefined,
      "anthropic/claude-sonnet-5.5",
      "openai/gpt-6.1-sol",
      { contentMultiplier: 1.37, text: { defaultCharsPerToken: 3 } },
    ] as const) {
      const estimator = createUsageEstimator(profile);
      for (const text of texts) {
        const expected = countText(text, { profile });
        expect(estimator.count({ text }), text).toBe(expected);
      }
    }
  });

  it("counts no request overhead for a text", () => {
    const estimator = createUsageEstimator("anthropic/claude-sonnet-5.5");
    const text = "What is the weather in Boston?";
    expect(
      estimator.count({ messages: [{ role: "user", content: text }] }),
    ).toBeGreaterThan(estimator.count({ text }));
  });

  it("rejects a breakdown of a text and an input without text or messages", () => {
    const estimator = createUsageEstimator();
    expect(() =>
      estimator.count({ text: "a" }, { breakdown: true } as never),
    ).toThrow(/breakdown/);
    expect(() => estimator.count({} as never)).toThrow(/messages/);
  });
});

describe("estimator text methods", () => {
  const estimator = createUsageEstimator("anthropic/claude-sonnet-5.5");
  const text = "The harbor library opens before sunrise. ".repeat(40);

  it("checks a text or a request against a limit", () => {
    const tokens = estimator.count({ text });
    expect(estimator.isWithinTokenLimit({ text }, tokens)).toBe(true);
    expect(estimator.isWithinTokenLimit({ text }, tokens - 1)).toBe(false);
    const request = { messages: [{ role: "user" as const, content: text }] };
    const requestTokens = estimator.count(request);
    expect(requestTokens).toBeGreaterThan(tokens);
    expect(estimator.isWithinTokenLimit(request, requestTokens)).toBe(true);
    expect(estimator.isWithinTokenLimit(request, tokens)).toBe(false);
  });

  it("slices and splits by the estimator's profile", () => {
    const start = estimator.sliceByTokens(text, 0, 10);
    expect(text.startsWith(start)).toBe(true);
    expect(estimator.count({ text: start })).toBeLessThanOrEqual(10);
    expect(estimator.sliceByTokens(text, -10)).toBe(
      text.slice(text.length - estimator.sliceByTokens(text, -10).length),
    );
    const chunks = estimator.splitByTokens(text, 50);
    expect(chunks.join("")).toBe(text);
    for (const chunk of chunks.slice(0, -1))
      expect(estimator.count({ text: chunk })).toBeGreaterThanOrEqual(50);
    // Overlapping chunks repeat the end of the previous chunk.
    const overlapping = estimator.splitByTokens(text, 50, { overlap: 10 });
    expect(overlapping.length).toBeGreaterThan(chunks.length);
    expect(estimator.splitByTokens("", 50)).toEqual([]);
    expect(estimator.splitByTokens(text, 0)).toEqual([]);
  });

  it("applies custom language configs to texts and requests", () => {
    const hebrew = "שלום עולם, מה שלומך היום?";
    const custom = createUsageEstimator(undefined, {
      languageConfigs: [{ pattern: /[֐-׿]/, averageCharsPerToken: 1 }],
    });
    const plain = createUsageEstimator();
    expect(custom.count({ text: hebrew })).toBeGreaterThan(
      plain.count({ text: hebrew }),
    );
    const request = { messages: [{ role: "user" as const, content: hebrew }] };
    expect(custom.count(request) - plain.count(request)).toBe(
      custom.count({ text: hebrew }) - plain.count({ text: hebrew }),
    );
  });
});
