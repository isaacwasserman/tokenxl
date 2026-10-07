import { Buffer } from "node:buffer";
import type { AssistantModelMessage, ModelMessage } from "ai";
import type { GroundTruthCounter } from "../tune/types.ts";
import { resolveJsonSchema } from "../usage/schema.ts";
import type { UsageInput } from "../usage/types.ts";
import type { ProviderAdapter, ProviderAdapterOptions } from "./types.ts";
import { MAX_OUTPUT_TOKENS } from "./types.ts";

interface ClaudeRequest {
  messages: {
    role: "user" | "assistant";
    content: Record<string, unknown>[];
  }[];
  system?: { type: "text"; text: string }[];
  tools?: { name: string; description?: string; input_schema: unknown }[];
}

/** Adaptive thinking at the given effort; without one, no thinking settings, so the model uses its defaults. */
export function thinkingParameters(effort?: string): Record<string, unknown> {
  return effort
    ? { thinking: { type: "adaptive" }, output_config: { effort } }
    : {};
}

export interface AnthropicCounterOptions {
  apiKey: string;
  modelId: string;
}

/** Maps only the input types exercised by the integration fixtures. */
export function toClaudeRequest(input: UsageInput): ClaudeRequest {
  const request: ClaudeRequest = { messages: [] };
  for (const message of input.messages) {
    if (message.role === "system") {
      request.system ??= [];
      request.system.push({ type: "text", text: message.content });
      continue;
    }
    const role = message.role === "tool" ? "user" : message.role;
    const content =
      typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : message.content.map((part) => toClaudePart(part));
    const previous = request.messages.at(-1);
    // Claude combines adjacent turns with the same role.
    if (previous?.role === role) previous.content.push(...content);
    else request.messages.push({ role, content });
  }
  if (
    !request.messages.length ||
    request.messages[0]!.role !== "user" ||
    request.messages.at(-1)!.role !== "user"
  )
    throw new TypeError(
      "Anthropic fixtures must start and finish with a user turn; assistant prefills are excluded.",
    );
  if (input.tools && Object.keys(input.tools).length) {
    request.tools = Object.entries(input.tools).map(([name, tool]) => {
      const schema = resolveJsonSchema(tool.inputSchema);
      if (!schema)
        throw new TypeError(`Cannot resolve the schema for ${name}.`);
      if (
        tool.description !== undefined &&
        typeof tool.description !== "string"
      )
        throw new TypeError(
          "Dynamic tool descriptions are excluded from the integration fixtures.",
        );
      return {
        name,
        ...(tool.description !== undefined
          ? { description: tool.description }
          : {}),
        input_schema: schema,
      };
    });
  }
  return request;
}

function toClaudePart(
  part: Exclude<ModelMessage["content"], string>[number],
): Record<string, unknown> {
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text };
    case "reasoning": {
      const metadata = part.providerOptions?.anthropic;
      if (typeof metadata?.signature === "string" && metadata.signature)
        return {
          type: "thinking",
          thinking: part.text,
          signature: metadata.signature,
        };
      if (typeof metadata?.redactedData === "string" && metadata.redactedData)
        return { type: "redacted_thinking", data: metadata.redactedData };
      throw new TypeError(
        "Anthropic reasoning fixtures require an authentic signature or redactedData from a model response.",
      );
    }
    case "image":
      return { type: "image", source: source(part.image, "image/png") };
    case "file":
      if (part.mediaType !== "application/pdf")
        throw new TypeError("Only PDF file fixtures are supported.");
      return { type: "document", source: source(part.data, part.mediaType) };
    case "tool-call":
      return {
        type: "tool_use",
        id: part.toolCallId,
        name: part.toolName,
        input: part.input,
      };
    case "tool-result": {
      const output = part.output as { type: string; value: unknown };
      if (!["text", "json", "error-text", "error-json"].includes(output.type))
        throw new TypeError(`Unsupported tool output: ${output.type}`);
      return {
        type: "tool_result",
        tool_use_id: part.toolCallId,
        content: output.type.endsWith("json")
          ? JSON.stringify(output.value)
          : output.value,
        ...(output.type.startsWith("error-") ? { is_error: true } : {}),
      };
    }
    default:
      throw new TypeError(`Unsupported Anthropic fixture part: ${part.type}`);
  }
}

function source(
  value: unknown,
  mediaType: string,
): { type: "base64"; media_type: string; data: string } {
  if (typeof value === "string") {
    const url = /^data:([^;]+);base64,([\s\S]+)$/.exec(value);
    if (url) return { type: "base64", media_type: url[1]!, data: url[2]! };
    if (value.includes(":"))
      throw new TypeError(
        "Remote media URLs are excluded from the integration fixtures.",
      );
    return { type: "base64", media_type: mediaType, data: value };
  }
  const bytes =
    value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : ArrayBuffer.isView(value)
        ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
        : undefined;
  if (!bytes) throw new TypeError("Expected inline base64 or binary media.");
  return {
    type: "base64",
    media_type: mediaType,
    data: Buffer.from(bytes).toString("base64"),
  };
}

/** Anthropic rejects reasoning without a signature or redacted data, and requests that end with an assistant tool call. */
export function supportsAnthropicInput(input: UsageInput): boolean {
  if (
    input.messages.some(
      (message) =>
        Array.isArray(message.content) &&
        message.content.some(
          (part) =>
            part.type === "reasoning" &&
            !part.providerOptions?.anthropic?.signature &&
            !part.providerOptions?.anthropic?.redactedData,
        ),
    )
  )
    return false;
  const last = input.messages.at(-1);
  return !(
    last?.role === "assistant" &&
    Array.isArray(last.content) &&
    last.content.some((part) => part.type === "tool-call")
  );
}

/** Calls the token-counting API only; no generated response. */
export function createAnthropicCounter(
  options: AnthropicCounterOptions,
): GroundTruthCounter {
  const { apiKey, modelId } = options;
  return async (input) => {
    const body = JSON.stringify({ model: modelId, ...toClaudeRequest(input) });
    const response = await fetch(
      "https://api.anthropic.com/v1/messages/count_tokens",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          "x-api-key": apiKey,
        },
        body,
        signal: AbortSignal.timeout(30_000),
      },
    );
    const result = (await response.json()) as {
      input_tokens?: number;
      error?: { message?: string };
    };
    if (!response.ok)
      throw new Error(
        `Anthropic CountTokens HTTP ${response.status}: ${result.error?.message ?? response.statusText}`,
      );
    return validCount(result.input_tokens);
  };
}

function validCount(count: number | undefined): number {
  if (!Number.isInteger(count) || count! < 0)
    throw new TypeError(
      "Anthropic did not return a nonnegative integer input token count.",
    );
  return count!;
}

export type ThinkingResponsePart =
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

export interface ThinkingResponse {
  content: ThinkingResponsePart[];
  stop_reason: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

/** Preserve the provider's complete blocks, including opaque encrypted thinking. */
export function reasoningMessage(
  content: ThinkingResponsePart[],
): AssistantModelMessage {
  return {
    role: "assistant",
    content: content.map((part) => {
      switch (part.type) {
        case "text":
          return { type: "text", text: part.text };
        case "thinking":
          return {
            type: "reasoning",
            text: part.thinking,
            providerOptions: { anthropic: { signature: part.signature } },
          };
        case "redacted_thinking":
          return {
            type: "reasoning",
            text: "",
            providerOptions: { anthropic: { redactedData: part.data } },
          };
        case "tool_use":
          return {
            type: "tool-call",
            toolCallId: part.id,
            toolName: part.name,
            input: part.input,
          };
        default:
          throw new TypeError("Unexpected block in the thinking response.");
      }
    }),
  };
}

/** Generates one response with signed thinking blocks. */
export async function generateThinking(
  input: UsageInput,
  options: AnthropicCounterOptions & { signal?: AbortSignal; effort?: string },
): Promise<ThinkingResponse> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": options.apiKey,
    },
    body: JSON.stringify({
      model: options.modelId,
      max_tokens: MAX_OUTPUT_TOKENS,
      ...thinkingParameters(options.effort),
      ...toClaudeRequest(input),
    }),
    signal: AbortSignal.any([
      ...(options.signal ? [options.signal] : []),
      AbortSignal.timeout(180_000),
    ]),
  });
  const result = (await response.json()) as ThinkingResponse & {
    error?: { message?: string };
  };
  if (!response.ok)
    throw new Error(
      `Anthropic Messages HTTP ${response.status}: ${result.error?.message ?? response.statusText}`,
    );
  return result;
}

/** Counts with the free CountTokens endpoint and generates with the Messages API. */
export function createAnthropicAdapter(
  options: ProviderAdapterOptions,
): ProviderAdapter {
  const { apiKey, modelId, reasoningLevel } = options;
  return {
    countTokens: createAnthropicCounter({ apiKey, modelId }),
    supportsInput: supportsAnthropicInput,
    invokeModel: async (input, { signal }) => {
      const response = await generateThinking(input, {
        apiKey,
        modelId,
        ...(signal ? { signal } : {}),
        ...(reasoningLevel ? { effort: reasoningLevel } : {}),
      });
      // An incomplete response ends the conversation; it was still generated and billed.
      const complete =
        response.stop_reason === "end_turn" ||
        response.stop_reason === "tool_use";
      return {
        messages: complete ? [reasoningMessage(response.content)] : null,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
      };
    },
  };
}
