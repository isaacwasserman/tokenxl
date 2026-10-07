import { afterEach, expect, it, vi } from "vitest";
import type { UsageInput } from "../src/index.ts";
import { createUsageEstimator, estimateTokenCount } from "../src/index.ts";
import { createProviderAdapter } from "../src/provider-adapters/index.ts";
import {
  generateOpenAIReasoning,
  openaiReasoningMessage,
  supportsOpenAIInput,
  toResponsesRequest,
} from "../src/provider-adapters/openai.ts";

afterEach(() => vi.unstubAllGlobals());

const output = [
  {
    type: "reasoning",
    id: "rs_1",
    encrypted_content: "x".repeat(400),
    summary: [
      { type: "summary_text" as const, text: "First idea." },
      { type: "summary_text" as const, text: "Second idea." },
    ],
  },
  { type: "message", content: [{ type: "output_text", text: "The answer." }] },
];

function history(): UsageInput {
  return {
    messages: [
      { role: "user", content: "A question." },
      openaiReasoningMessage(output),
      { role: "user", content: "Continue." },
    ],
  };
}

it("maps a response as the AI SDK does and sends it back as one reasoning item", () => {
  const message = openaiReasoningMessage(output);
  expect(message.content).toEqual([
    {
      type: "reasoning",
      text: "First idea.",
      providerOptions: {
        openai: { itemId: "rs_1", reasoningEncryptedContent: "x".repeat(400) },
      },
    },
    {
      type: "reasoning",
      text: "Second idea.",
      providerOptions: {
        openai: { itemId: "rs_1", reasoningEncryptedContent: "x".repeat(400) },
      },
    },
    { type: "text", text: "The answer." },
  ]);
  expect(toResponsesRequest(history()).input).toEqual([
    { role: "user", content: "A question." },
    {
      type: "reasoning",
      id: "rs_1",
      encrypted_content: "x".repeat(400),
      summary: [
        { type: "summary_text", text: "First idea." },
        { type: "summary_text", text: "Second idea." },
      ],
    },
    {
      role: "assistant",
      content: [{ type: "output_text", text: "The answer." }],
    },
    { role: "user", content: "Continue." },
  ]);
  expect(supportsOpenAIInput(history())).toBe(true);
});

it("rejects reasoning without encrypted content instead of counting a different request", () => {
  const input: UsageInput = {
    messages: [
      { role: "user", content: "A question." },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "Synthetic." },
          { type: "text", text: "Answer." },
        ],
      },
      { role: "user", content: "Continue." },
    ],
  };
  expect(() => toResponsesRequest(input)).toThrow(/encrypted/);
  expect(supportsOpenAIInput(input)).toBe(false);
});

it("generates with encrypted reasoning and no storage, and reports incomplete responses", async () => {
  const response = {
    status: "completed",
    output,
    usage: { input_tokens: 10, output_tokens: 20 },
  };
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json(response))
    .mockResolvedValueOnce(
      Response.json({
        ...response,
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
      }),
    );
  vi.stubGlobal("fetch", fetch);
  const options = { modelId: "test-model", apiKey: "test-key", effort: "high" };
  await expect(
    generateOpenAIReasoning(
      { messages: [{ role: "user", content: "A question." }] },
      options,
    ),
  ).resolves.toEqual(response);
  expect(fetch.mock.calls[0]![0]).toBe("https://api.openai.com/v1/responses");
  expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({
    model: "test-model",
    input: [{ role: "user", content: "A question." }],
    reasoning: { effort: "high", summary: "auto" },
    include: ["reasoning.encrypted_content"],
    store: false,
    max_output_tokens: 4096,
  });
  // The adapter ends a conversation on an incomplete response and still reports its usage.
  const adapter = createProviderAdapter("openai", {
    modelId: "test-model",
    apiKey: "test-key",
  });
  await expect(
    adapter.invokeModel!(
      { messages: [{ role: "user", content: "A question." }] },
      {},
    ),
  ).resolves.toMatchObject({ messages: null });
});
