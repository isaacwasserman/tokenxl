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
import { removeReasoningPayloads } from "../src/tune/reasoning.ts";

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

it("charges each OpenAI reasoning item once by its payload, without summary text", () => {
  const profile = {
    baseOverhead: 0,
    perMessage: 0,
    perReasoning: 40,
    perReasoningPayloadChar: 0.5,
    reasoningPayloadEnvelopeChars: 10,
  };
  const answer =
    estimateTokenCount("The answer.") +
    estimateTokenCount("A question.") +
    estimateTokenCount("Continue.");
  expect(createUsageEstimator(profile).count(history())).toBe(answer - 5 + 200);
  const breakdown = createUsageEstimator(profile).count(history(), {
    breakdown: true,
  });
  expect(breakdown.messages[1]!.parts.map((part) => part.total)).toEqual([
    195,
    0,
    estimateTokenCount("The answer."),
  ]);
  // Stored items have no payload: one perReasoning per item, plus each summary.
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
  expect(createUsageEstimator(profile).count(stored)).toBe(
    40 + estimateTokenCount("First idea.") + estimateTokenCount("Second idea."),
  );
  expect(removeReasoningPayloads(history()).messages[1]!.content).toEqual([
    { type: "text", text: "The answer." },
  ]);
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
