import type { UsageInput } from "@tokenxl/count";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createProviderAdapter,
  getModelKey,
} from "../src/provider-adapters/index.ts";

afterEach(() => vi.unstubAllGlobals());

/** Answers each request with the next response and records the URL and body. */
function stubFetch(...responses: Response[]): { url: string; body: any }[] {
  const calls: { url: string; body: any }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return responses.shift() ?? Response.json({}, { status: 500 });
    }),
  );
  return calls;
}

const question: UsageInput = {
  messages: [
    { role: "system", content: "Be brief." },
    { role: "user", content: "A question." },
  ],
};

describe("anthropic", () => {
  const anthropicMessage = (stopReason: string) =>
    Response.json({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-test",
      content: [
        { type: "thinking", thinking: "", signature: "opaque-signature" },
        { type: "text", text: "Done." },
      ],
      stop_reason: stopReason,
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 7 },
    });

  it("counts the request the AI SDK would send, without generation settings", async () => {
    const calls = stubFetch(Response.json({ input_tokens: 123 }));
    const adapter = createProviderAdapter("anthropic", {
      apiKey: "key",
      modelId: "claude-test",
      reasoningLevel: "high",
    });
    await expect(adapter.countTokens(question)).resolves.toBe(123);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "https://api.anthropic.com/v1/messages/count_tokens",
    );
    expect(Object.keys(calls[0]!.body).sort()).toEqual([
      "messages",
      "model",
      "system",
    ]);
  });

  it("generates at the adapter's effort, keeps signatures, and ends on truncation", async () => {
    const calls = stubFetch(
      anthropicMessage("end_turn"),
      anthropicMessage("max_tokens"),
    );
    const adapter = createProviderAdapter("anthropic", {
      apiKey: "key",
      modelId: "claude-test",
      reasoningLevel: "high",
    });
    const done = await adapter.invokeModel!(question, {});
    expect(calls[0]!.body).toMatchObject({
      max_tokens: 4096,
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
    });
    expect(JSON.stringify(done)).toContain("opaque-signature");
    await expect(adapter.invokeModel!(question, {})).resolves.toEqual({
      messages: null,
      usage: { inputTokens: 5, outputTokens: 7 },
    });
  });

  it("sends no thinking settings without a level", async () => {
    const calls = stubFetch(anthropicMessage("end_turn"));
    const adapter = createProviderAdapter("anthropic", {
      apiKey: "key",
      modelId: "claude-test",
    });
    await adapter.invokeModel!(question, {});
    expect(calls[0]!.body.thinking).toBeUndefined();
    expect(calls[0]!.body.output_config).toBeUndefined();
  });
});

describe("openai", () => {
  const response = (status: string) =>
    Response.json({
      id: "resp_1",
      created_at: 0,
      model: "gpt-test",
      status,
      incomplete_details:
        status === "completed" ? null : { reason: "max_output_tokens" },
      output: [
        {
          type: "reasoning",
          id: "rs_1",
          encrypted_content: "x".repeat(40),
          summary: [{ type: "summary_text", text: "An idea." }],
        },
        {
          type: "message",
          id: "msg_1",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "Done.", annotations: [] }],
        },
      ],
      usage: { input_tokens: 5, output_tokens: 7 },
    });

  it("counts reasoning items with their encrypted content, as stored-off requests send them", async () => {
    const calls = stubFetch(Response.json({ input_tokens: 77 }));
    const adapter = createProviderAdapter("openai", {
      apiKey: "key",
      modelId: "gpt-6.1-sol",
    });
    const history: UsageInput = {
      messages: [
        { role: "user", content: "A question." },
        {
          role: "assistant",
          content: [
            {
              type: "reasoning",
              text: "An idea.",
              providerOptions: {
                openai: { itemId: "rs_1", reasoningEncryptedContent: "enc" },
              },
            },
            { type: "text", text: "Done." },
          ],
        },
        { role: "user", content: "Continue." },
      ],
    };
    await expect(adapter.countTokens(history)).resolves.toBe(77);
    expect(calls[0]!.url).toBe(
      "https://api.openai.com/v1/responses/input_tokens",
    );
    expect(calls[0]!.body.store).toBeUndefined();
    expect(JSON.stringify(calls[0]!.body.input)).toContain(
      '"encrypted_content":"enc"',
    );
  });

  it("generates without storage, with encrypted reasoning, and ends on truncation", async () => {
    const calls = stubFetch(response("completed"), response("incomplete"));
    const adapter = createProviderAdapter("openai", {
      apiKey: "key",
      modelId: "gpt-6.1-sol",
      reasoningLevel: "high",
    });
    const done = await adapter.invokeModel!(question, {});
    expect(calls[0]!.body).toMatchObject({
      store: false,
      include: ["reasoning.encrypted_content"],
      reasoning: { effort: "high", summary: "auto" },
      max_output_tokens: 4096,
    });
    expect(JSON.stringify(done)).toContain("x".repeat(40));
    await expect(adapter.invokeModel!(question, {})).resolves.toMatchObject({
      messages: null,
    });
  });
});

describe("openrouter", () => {
  it("counts with a 1-token generation and falls back when settings are rejected", async () => {
    const completion = Response.json({
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
    });
    const calls = stubFetch(
      Response.json(
        { error: { message: "max_tokens must be at least 16", code: 400 } },
        { status: 400 },
      ),
      completion,
    );
    const adapter = createProviderAdapter("openrouter", {
      apiKey: "key",
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
    expect(calls[0]!.body).toMatchObject({
      max_tokens: 1,
      reasoning: { effort: "none" },
    });
    expect(calls[1]!.body).toMatchObject({
      max_tokens: 16,
      reasoning: { effort: "none" },
    });
  });
});

describe("supportsInput", () => {
  const call = {
    role: "assistant" as const,
    content: [
      {
        type: "tool-call" as const,
        toolCallId: "call_1",
        toolName: "lookup",
        input: {},
      },
    ],
  };
  const cases: [string, UsageInput, boolean, boolean][] = [
    // [case, input, Anthropic accepts, OpenAI accepts]
    ["a plain question", question, true, true],
    [
      "a system message after the conversation starts",
      {
        messages: [
          { role: "user", content: "Hi." },
          { role: "system", content: "Late." },
        ],
      },
      false,
      false,
    ],
    [
      "a tool call without a result",
      { messages: [{ role: "user", content: "Look." }, call] },
      false,
      false,
    ],
    [
      "reasoning without a provider payload",
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "reasoning", text: "Plain." }],
          },
          { role: "user", content: "Next." },
        ],
      },
      false,
      false,
    ],
  ];
  it.each(cases)("%s", async (_, input, anthropic, openai) => {
    const options = { apiKey: "key", modelId: "test" };
    expect(
      await createProviderAdapter("anthropic", options).supportsInput!(input),
    ).toBe(anthropic);
    expect(
      await createProviderAdapter("openai", options).supportsInput!(input),
    ).toBe(openai);
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
