import type { ModelMessage } from "ai";
import { afterEach, expect, it, vi } from "vitest";
import type { UsageInput } from "../src/index.ts";
import { createUsageEstimator, estimateTokenCount } from "../src/index.ts";
import {
  createProviderAdapter,
  getModelKey,
} from "../src/provider-adapters/index.ts";
import { supportsOpenRouterInput } from "../src/provider-adapters/openrouter.ts";
import { removeReasoningPayloads } from "../src/tune/reasoning.ts";
import { extractReasoningPayloads } from "../src/usage/messages.ts";

afterEach(() => vi.unstubAllGlobals());

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
  const lengths = (message: ModelMessage): number[] =>
    extractReasoningPayloads(message, new Set()).map(
      (entry) => entry.payload.length,
    );
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
  expect(
    lengths({ role: "assistant", content: parts } as ModelMessage),
  ).toEqual([200, 300]);
  expect(
    lengths({ role: "assistant", content: parts.slice(0, 1) } as ModelMessage),
  ).toEqual([200]);
  expect(
    lengths({
      role: "assistant",
      content: parts,
      providerOptions: details([encrypted]),
    } as ModelMessage),
  ).toEqual([300]);
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
  ).toEqual([300]);
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
  ).toEqual([15]);
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
  const text = estimateTokenCount("First.") + estimateTokenCount("Second.");
  // The same detail repeated in a later message is sent once.
  expect(createUsageEstimator(profile).count(input)).toBe(
    text + 0.5 * (200 - 100),
  );
  expect(
    removeReasoningPayloads(input).messages.map((m) =>
      (m.content as { type: string }[]).map((part) => part.type),
    ),
  ).toEqual([["text"], ["text"]]);
  const onCall: UsageInput = {
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call_1",
            toolName: "lookup",
            input: {},
            providerOptions: details([encrypted]),
          },
        ],
      } as ModelMessage,
    ],
  };
  const stripped = removeReasoningPayloads(onCall).messages[0]!.content as {
    providerOptions?: { openrouter?: object };
  }[];
  expect(stripped[0]!.providerOptions!.openrouter).toEqual({});
});

it("counts through OpenRouter with a 1-token generation and falls back when settings are rejected", async () => {
  const bodies: unknown[] = [];
  const completion = {
    id: "gen-1",
    object: "chat.completion",
    created: 0,
    model: "test",
    choices: [
      {
        index: 0,
        finish_reason: "length",
        message: { role: "assistant", content: "A" },
      },
    ],
    usage: { prompt_tokens: 42, completion_tokens: 1, total_tokens: 43 },
  };
  const fetch = vi.fn(async (_url: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body));
    return bodies.length === 1
      ? Response.json(
          { error: { message: "max_tokens must be at least 16", code: 400 } },
          { status: 400 },
        )
      : Response.json(completion);
  });
  vi.stubGlobal("fetch", fetch);
  const adapter = createProviderAdapter("openrouter", {
    apiKey: "test-key",
    modelId: "anthropic/claude-sonnet-4.5",
  });
  // Each count is a billed generation; the rejected attempt is not billed.
  await expect(
    adapter.countTokens({
      messages: [{ role: "user", content: "Count this." }],
    }),
  ).resolves.toEqual({
    count: 42,
    usage: { inputTokens: 42, outputTokens: 1 },
  });
  expect(bodies[0]).toMatchObject({
    model: "anthropic/claude-sonnet-4.5",
    max_tokens: 1,
    reasoning: { effort: "none" },
  });
  expect(bodies[1]).toMatchObject({
    max_tokens: 16,
    reasoning: { effort: "none" },
  });
  // The accepted settings are used for later counts. Leading system messages go
  // through the AI SDK's instructions, each as its own system message.
  await adapter.countTokens({
    messages: [
      { role: "system", content: "One." },
      { role: "system", content: "Two." },
      { role: "user", content: "Again." },
    ],
  });
  expect(bodies[2]).toMatchObject({
    max_tokens: 16,
    messages: [
      { role: "system", content: [{ type: "text", text: "One." }] },
      { role: "system", content: [{ type: "text", text: "Two." }] },
      { role: "user", content: "Again." },
    ],
  });
  const text = { inputModalities: new Set(["text"]), tools: true };
  expect(
    supportsOpenRouterInput(
      {
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: "x",
                toolName: "lookup",
                input: {},
              },
            ],
          },
        ],
      },
      text,
    ),
  ).toBe(false);
  expect(
    supportsOpenRouterInput(
      {
        messages: [
          { role: "user", content: "Hi." },
          { role: "system", content: "Late." },
        ],
      },
      text,
    ),
  ).toBe(false);
  const image: UsageInput = {
    messages: [
      {
        role: "user",
        content: [{ type: "image", image: "data:image/png;base64,AAAA" }],
      },
    ],
  };
  expect(supportsOpenRouterInput(image, text)).toBe(false);
  expect(
    supportsOpenRouterInput(image, {
      inputModalities: new Set(["text", "image"]),
      tools: true,
    }),
  ).toBe(true);
});

it("sends no effort to OpenAI without a level, so the model uses its default", async () => {
  const output = [
    { type: "message", content: [{ type: "output_text", text: "Done." }] },
  ];
  const fetch = vi.fn(async (_url: string, _init: { body: string }) =>
    Response.json({
      status: "completed",
      output,
      usage: { input_tokens: 5, output_tokens: 5 },
    }),
  );
  vi.stubGlobal("fetch", fetch);
  const openai = createProviderAdapter("openai", {
    apiKey: "test-key",
    modelId: "gpt-6.1-sol",
  });
  await openai.invokeModel!(
    { messages: [{ role: "user", content: "A question." }] },
    {},
  );
  expect(JSON.parse(fetch.mock.calls[0]![1].body).reasoning).toEqual({
    summary: "auto",
  });
});

it("sends no thinking settings to Anthropic without a level, so the model uses its defaults", async () => {
  const fetch = vi.fn(async (_url: string, _init: { body: string }) =>
    Response.json({
      stop_reason: "end_turn",
      content: [{ type: "text", text: "Done." }],
      usage: { input_tokens: 5, output_tokens: 5 },
    }),
  );
  vi.stubGlobal("fetch", fetch);
  const adapter = createProviderAdapter("anthropic", {
    apiKey: "test-key",
    modelId: "claude-sonnet-4-5",
  });
  await expect(
    adapter.invokeModel!(
      { messages: [{ role: "user", content: "A question." }] },
      {},
    ),
  ).resolves.toMatchObject({ usage: { inputTokens: 5, outputTokens: 5 } });
  const body = JSON.parse(fetch.mock.calls[0]![1].body);
  expect(body.thinking).toBeUndefined();
  expect(body.output_config).toBeUndefined();
  // The adapter's level sets the effort of every generated response.
  await createProviderAdapter("anthropic", {
    apiKey: "test-key",
    modelId: "claude-sonnet-5-5",
    reasoningLevel: "high",
  }).invokeModel!({ messages: [{ role: "user", content: "A question." }] }, {});
  expect(JSON.parse(fetch.mock.calls[1]![1].body)).toMatchObject({
    max_tokens: 4096,
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
  });
});

it("keys models as provider/model with dotted versions and no snapshot dates", () => {
  expect(getModelKey("anthropic", "claude-sonnet-4-5-20250929")).toBe(
    "anthropic/claude-sonnet-4.5",
  );
  expect(getModelKey("anthropic", "claude-3-5-sonnet-20241022")).toBe(
    "anthropic/claude-3.5-sonnet",
  );
  expect(getModelKey("anthropic", "claude-opus-5-5")).toBe(
    "anthropic/claude-opus-5.5",
  );
  expect(getModelKey("openai", "gpt-5.1-2025-11-13")).toBe("openai/gpt-5.1");
  expect(getModelKey("openai", "gpt-4o-2024-08-06")).toBe("openai/gpt-4o");
  expect(getModelKey("openai", "gpt-6.1-sol")).toBe("openai/gpt-6.1-sol");
  expect(getModelKey("openrouter", "meta-llama/llama-3.3-70b-instruct")).toBe(
    "meta-llama/llama-3.3-70b-instruct",
  );
});
