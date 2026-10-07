import { jsonSchema, tool } from "ai";
import { afterEach, expect, it, vi } from "vitest";
import type { UsageInput } from "../src/index.ts";
import {
  createAnthropicCounter,
  generateThinking,
  reasoningMessage,
  supportsAnthropicInput,
  toClaudeRequest,
} from "../src/provider-adapters/anthropic.ts";
import { createProviderAdapter } from "../src/provider-adapters/index.ts";
import { createProbes } from "../src/tune/probes.ts";

afterEach(() => vi.unstubAllGlobals());

it("round-trips signed and redacted thinking without changing provider blocks", () => {
  const content = [
    {
      type: "thinking" as const,
      thinking: "A visible summary.",
      signature: "opaque-signature",
    },
    { type: "redacted_thinking" as const, data: "opaque-redacted-data" },
    { type: "text" as const, text: "The answer." },
  ];
  const before = {
    messages: [{ role: "user" as const, content: "A question." }],
  };
  const after = {
    messages: [
      before.messages[0]!,
      reasoningMessage(content),
      { role: "user" as const, content: "Continue." },
    ],
  };
  expect(toClaudeRequest(after).messages[1]!.content).toEqual(content);
  expect(supportsAnthropicInput(before) && supportsAnthropicInput(after)).toBe(
    true,
  );
});

it("rejects unsigned thinking instead of silently counting a different request", () => {
  expect(() =>
    toClaudeRequest({
      messages: [
        { role: "user", content: "A question." },
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "Synthetic reasoning." },
            { type: "text", text: "An answer." },
          ],
        },
        { role: "user", content: "Continue." },
      ],
    }),
  ).toThrow(/signature/);
});

it("generates at the given effort with the configured model and returns the response", async () => {
  const response = {
    content: [
      { type: "thinking", thinking: "", signature: "opaque-signature" },
      { type: "text", text: "21" },
    ],
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 20 },
  };
  const fetch = vi.fn().mockResolvedValue(Response.json(response));
  vi.stubGlobal("fetch", fetch);
  await expect(
    generateThinking(
      { messages: [{ role: "user", content: "A question." }] },
      { modelId: "test-model", apiKey: "test-key", effort: "high" },
    ),
  ).resolves.toEqual(response);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0]![0]).toBe("https://api.anthropic.com/v1/messages");
  expect(JSON.parse(fetch.mock.calls[0]![1].body)).toMatchObject({
    model: "test-model",
    max_tokens: 4096,
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
    messages: [
      { role: "user", content: [{ type: "text", text: "A question." }] },
    ],
  });
});

it("sends one count request with the configured model, credentials and input", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ input_tokens: 123 }));
  vi.stubGlobal("fetch", fetch);
  const counter = createAnthropicCounter({
    modelId: "test-model",
    apiKey: "test-key",
  });
  await expect(
    counter({ messages: [{ role: "user", content: "Count this." }] }),
  ).resolves.toBe(123);
  expect(fetch).toHaveBeenCalledTimes(1);
  for (const [url, request] of fetch.mock.calls) {
    expect(url).toBe("https://api.anthropic.com/v1/messages/count_tokens");
    expect(request.headers).toMatchObject({
      "x-api-key": "test-key",
      "anthropic-version": "2023-06-01",
    });
    expect(JSON.parse(request.body)).toEqual({
      model: "test-model",
      messages: [
        { role: "user", content: [{ type: "text", text: "Count this." }] },
      ],
    });
  }
});

it("propagates permanent API failures without retrying or estimating a count", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(
      Response.json({ error: { message: "Invalid request" } }, { status: 400 }),
    );
  vi.stubGlobal("fetch", fetch);
  const counter = createAnthropicCounter({
    modelId: "test-model",
    apiKey: "test-key",
  });
  await expect(
    counter({ messages: [{ role: "user", content: "Count this." }] }),
  ).rejects.toThrow("HTTP 400");
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("maps system prompts, schemas, tool calls and JSON results to the counted Claude request", () => {
  const schema = {
    type: "object" as const,
    properties: { query: { type: "string" as const } },
  };
  const request = toClaudeRequest({
    messages: [
      { role: "system", content: "Find records." },
      { role: "user", content: "Find books." },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "toolu_books",
            toolName: "search",
            input: { query: "books" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "toolu_books",
            toolName: "search",
            output: { type: "json", value: { found: 3 } },
          },
        ],
      },
      { role: "user", content: "Summarize the results." },
    ],
    tools: {
      search: tool({
        description: "Search the library.",
        inputSchema: jsonSchema(schema),
      }),
    },
  });
  expect(request.system).toEqual([{ type: "text", text: "Find records." }]);
  expect(request.tools).toEqual([
    {
      name: "search",
      description: "Search the library.",
      input_schema: schema,
    },
  ]);
  expect(request.messages).toEqual([
    { role: "user", content: [{ type: "text", text: "Find books." }] },
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_books",
          name: "search",
          input: { query: "books" },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_books",
          content: '{"found":3}',
        },
        { type: "text", text: "Summarize the results." },
      ],
    },
  ]);
});

it("preserves inline media bytes and marks error tool results", () => {
  const request = toClaudeRequest({
    messages: [
      {
        role: "user",
        content: [
          { type: "image", image: "data:image/png;base64,AQID" },
          {
            type: "file",
            mediaType: "application/pdf",
            data: new Uint8Array([4, 5, 6]),
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "toolu_error",
            toolName: "search",
            input: {},
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "toolu_error",
            toolName: "search",
            output: { type: "error-text", value: "Unavailable" },
          },
        ],
      },
    ],
  });
  expect(request.messages[0]!.content).toEqual([
    {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AQID" },
    },
    {
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: "BAUG" },
    },
  ]);
  expect(request.messages.at(-1)!.content[0]).toEqual({
    type: "tool_result",
    tool_use_id: "toolu_error",
    content: "Unavailable",
    is_error: true,
  });
});

it("accepts every supported probe, including complete tool exchanges and media", () => {
  const probes = createProbes();
  const overhead = probes.overhead.filter(
    (probe) =>
      supportsAnthropicInput(probe.before) &&
      supportsAnthropicInput(probe.after),
  );
  const requests = [
    ...probes.text,
    ...(probes.textRules ?? []).flatMap((probe) => [probe.before, probe.after]),
    ...(probes.textContext ?? []).flatMap((probe) => [
      probe.before,
      probe.after,
    ]),
    ...overhead.flatMap((probe) => [probe.before, probe.after]),
  ].map(toClaudeRequest);
  expect(
    requests.every((request) => request.messages.at(-1)!.role === "user"),
  ).toBe(true);
  const types = requests.flatMap((request) =>
    request.messages.flatMap((message) =>
      message.content.map((part) => part.type),
    ),
  );
  expect(types).toContain("tool_use");
  expect(types).toContain("tool_result");
  expect(types).toContain("image");
  expect(types).toContain("document");
  expect(overhead.length).toBeLessThan(probes.overhead.length);
});

it("counts the same history it generates, without the generation settings", async () => {
  const response = {
    content: [{ type: "text", text: "Done." }],
    stop_reason: "end_turn",
    usage: { input_tokens: 20, output_tokens: 2 },
  };
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json(response))
    .mockResolvedValueOnce(Response.json({ input_tokens: 20 }));
  vi.stubGlobal("fetch", fetch);
  const options = { modelId: "test-model", apiKey: "test-key" };
  const input: UsageInput = {
    messages: [
      { role: "system", content: "A system prompt." },
      { role: "user", content: "The original question." },
      reasoningMessage([
        { type: "thinking", thinking: "", signature: "authentic-signature" },
        { type: "text", text: "An answer." },
      ]),
      { role: "user", content: "Check again." },
    ],
  };
  await generateThinking(input, { ...options, effort: "max" });
  await createAnthropicCounter(options)(input);
  const { max_tokens, thinking, output_config, ...generated } = JSON.parse(
    fetch.mock.calls[0]![1].body,
  );
  const counted = JSON.parse(fetch.mock.calls[1]![1].body);
  expect([max_tokens, thinking, output_config]).toEqual([
    4096,
    { type: "adaptive" },
    { effort: "max" },
  ]);
  expect(counted).toEqual(generated);
  expect(counted.messages[1].content[0]).toEqual({
    type: "thinking",
    thinking: "",
    signature: "authentic-signature",
  });
});

it("ends a conversation on a truncated response and still reports its usage", async () => {
  const response = {
    content: [{ type: "thinking", thinking: "", signature: "opaque" }],
    stop_reason: "max_tokens",
    usage: { input_tokens: 40, output_tokens: 4096 },
  };
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(response)));
  const adapter = createProviderAdapter("anthropic", {
    modelId: "test-model",
    apiKey: "test-key",
    reasoningLevel: "high",
  });
  await expect(
    adapter.invokeModel!(
      { messages: [{ role: "user", content: "A question." }] },
      {},
    ),
  ).resolves.toEqual({
    messages: null,
    usage: { inputTokens: 40, outputTokens: 4096 },
  });
});
