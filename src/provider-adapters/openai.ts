import { Buffer } from "node:buffer";
import type { AssistantModelMessage, ModelMessage } from "ai";
import type { GroundTruthCounter } from "../tune/types.ts";
import { resolveJsonSchema } from "../usage/schema.ts";
import type { UsageInput } from "../usage/types.ts";
import type { ProviderAdapter, ProviderAdapterOptions } from "./types.ts";
import { MAX_OUTPUT_TOKENS } from "./types.ts";

type ResponsesItem = Record<string, unknown>;

interface ResponsesRequest {
  input: ResponsesItem[];
  tools?: {
    type: "function";
    name: string;
    description?: string;
    parameters: unknown;
    strict: false;
  }[];
}

export interface OpenAICounterOptions {
  apiKey: string;
  modelId: string;
}

/** Maps only the input types exercised by the integration fixtures, as the AI SDK Responses provider sends them. */
export function toResponsesRequest(input: UsageInput): ResponsesRequest {
  const request: ResponsesRequest = { input: [] };
  const reasoningItems = new Map<string, ResponsesItem>();
  for (const message of input.messages) {
    if (message.role === "system") {
      // The AI SDK sends system messages to reasoning models as developer messages.
      request.input.push({ role: "developer", content: message.content });
      continue;
    }
    if (typeof message.content === "string") {
      request.input.push({ role: message.role, content: message.content });
      continue;
    }
    let content: ResponsesItem[] = [];
    const flush = (): void => {
      if (content.length) request.input.push({ role: message.role, content });
      content = [];
    };
    for (const part of message.content as Exclude<
      ModelMessage["content"],
      string
    >) {
      switch (part.type) {
        case "text":
          content.push({
            type: message.role === "assistant" ? "output_text" : "input_text",
            text: part.text,
          });
          break;
        case "image":
          content.push({
            type: "input_image",
            image_url: dataUrl(part.image, "image/png"),
            detail: "auto",
          });
          break;
        case "file":
          if (part.mediaType !== "application/pdf")
            throw new TypeError("Only PDF file fixtures are supported.");
          content.push({
            type: "input_file",
            filename: "probe.pdf",
            file_data: dataUrl(part.data, part.mediaType),
          });
          break;
        case "tool-call":
          flush();
          request.input.push({
            type: "function_call",
            call_id: part.toolCallId,
            name: part.toolName,
            arguments: JSON.stringify(part.input),
          });
          break;
        case "tool-result": {
          const output = part.output as { type: string; value: unknown };
          if (
            !["text", "json", "error-text", "error-json"].includes(output.type)
          )
            throw new TypeError(`Unsupported tool output: ${output.type}`);
          request.input.push({
            type: "function_call_output",
            call_id: part.toolCallId,
            output: output.type.endsWith("json")
              ? JSON.stringify(output.value)
              : output.value,
          });
          break;
        }
        case "reasoning": {
          // As the AI SDK sends reasoning with `store: false`: one item per item ID,
          // with a summary entry for each nonempty part.
          const options = part.providerOptions?.openai as
            | { itemId?: string; reasoningEncryptedContent?: string }
            | undefined;
          if (!options?.reasoningEncryptedContent)
            throw new TypeError(
              "OpenAI reasoning fixtures require encrypted reasoning items from a model response.",
            );
          flush();
          const summary = part.text
            ? [{ type: "summary_text", text: part.text }]
            : [];
          const existing = options.itemId
            ? reasoningItems.get(options.itemId)
            : undefined;
          if (existing) {
            (existing.summary as ResponsesItem[]).push(...summary);
            break;
          }
          const item: ResponsesItem = {
            type: "reasoning",
            ...(options.itemId ? { id: options.itemId } : {}),
            encrypted_content: options.reasoningEncryptedContent,
            summary,
          };
          if (options.itemId) reasoningItems.set(options.itemId, item);
          request.input.push(item);
          break;
        }
        default:
          throw new TypeError(`Unsupported OpenAI fixture part: ${part.type}`);
      }
    }
    flush();
  }
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
        type: "function",
        name,
        ...(tool.description !== undefined
          ? { description: tool.description }
          : {}),
        parameters: schema,
        strict: false,
      };
    });
  }
  return request;
}

function dataUrl(value: unknown, mediaType: string): string {
  if (typeof value === "string") {
    if (value.startsWith("data:")) return value;
    if (value.includes(":"))
      throw new TypeError(
        "Remote media URLs are excluded from the integration fixtures.",
      );
    return `data:${mediaType};base64,${value}`;
  }
  const bytes =
    value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : ArrayBuffer.isView(value)
        ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
        : undefined;
  if (!bytes) throw new TypeError("Expected inline base64 or binary media.");
  return `data:${mediaType};base64,${Buffer.from(bytes).toString("base64")}`;
}

/** OpenAI rejects reasoning without encrypted content, and tool calls without results. */
export function supportsOpenAIInput(input: UsageInput): boolean {
  const parts = input.messages.flatMap((message) =>
    Array.isArray(message.content)
      ? (message.content as {
          type: string;
          toolCallId?: string;
          providerOptions?: {
            openai?: { reasoningEncryptedContent?: unknown };
          };
        }[])
      : [],
  );
  const results = new Set(
    parts.flatMap((part) =>
      part.type === "tool-result" ? [part.toolCallId] : [],
    ),
  );
  return !parts.some(
    (part) =>
      (part.type === "reasoning" &&
        !part.providerOptions?.openai?.reasoningEncryptedContent) ||
      (part.type === "tool-call" && !results.has(part.toolCallId)),
  );
}

/** Calls the input-token counting endpoint only; no generated response. */
export function createOpenAICounter(
  options: OpenAICounterOptions,
): GroundTruthCounter {
  const { apiKey, modelId } = options;
  return async (input) => {
    const body = JSON.stringify({
      model: modelId,
      ...toResponsesRequest(input),
    });
    const response = await fetch(
      "https://api.openai.com/v1/responses/input_tokens",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
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
        `OpenAI input token count HTTP ${response.status}: ${result.error?.message ?? response.statusText}`,
      );
    if (!Number.isInteger(result.input_tokens) || result.input_tokens! < 0)
      throw new TypeError(
        "OpenAI did not return a nonnegative integer input token count.",
      );
    return result.input_tokens!;
  };
}

type OutputItem =
  | {
      type: "reasoning";
      id: string;
      encrypted_content?: string | null;
      summary: { type: "summary_text"; text: string }[];
    }
  | { type: "message"; content: { type: string; text?: string }[] }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: string };

export interface OpenAIReasoningResponse {
  status: string;
  incomplete_details?: { reason?: string } | null;
  output: OutputItem[];
  usage: {
    input_tokens: number;
    output_tokens: number;
    output_tokens_details?: { reasoning_tokens?: number };
  };
}

/** As the AI SDK maps a response: one reasoning part per summary, each with the item's encrypted content. */
export function openaiReasoningMessage(
  output: OutputItem[],
): AssistantModelMessage {
  const content: Exclude<AssistantModelMessage["content"], string> = [];
  for (const item of output) {
    if (item.type === "reasoning" && "summary" in item) {
      const summaries = item.summary.length
        ? item.summary
        : [{ type: "summary_text" as const, text: "" }];
      for (const summary of summaries)
        content.push({
          type: "reasoning",
          text: summary.text,
          providerOptions: {
            openai: {
              itemId: item.id,
              reasoningEncryptedContent: item.encrypted_content ?? null,
            },
          },
        });
    } else if (item.type === "function_call" && "call_id" in item) {
      content.push({
        type: "tool-call",
        toolCallId: item.call_id,
        toolName: item.name,
        input: JSON.parse(item.arguments),
      });
    } else if (item.type === "message" && "content" in item) {
      for (const part of item.content) {
        if (part.type === "output_text" && part.text)
          content.push({ type: "text", text: part.text });
      }
    } else {
      throw new TypeError(`Unexpected OpenAI output item: ${item.type}`);
    }
  }
  return { role: "assistant", content };
}

/** Generation with encrypted reasoning returned and nothing stored, as the AI SDK does with `store: false`. */
export async function generateOpenAIReasoning(
  input: UsageInput,
  options: OpenAICounterOptions & { signal?: AbortSignal; effort?: string },
): Promise<OpenAIReasoningResponse> {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${options.apiKey}`,
    },
    body: JSON.stringify({
      model: options.modelId,
      ...toResponsesRequest(input),
      reasoning: {
        ...(options.effort ? { effort: options.effort } : {}),
        summary: "auto",
      },
      include: ["reasoning.encrypted_content"],
      store: false,
      max_output_tokens: MAX_OUTPUT_TOKENS,
    }),
    // Long reasoning on slow models can take many minutes before the response arrives.
    signal: AbortSignal.any([
      ...(options.signal ? [options.signal] : []),
      AbortSignal.timeout(30 * 60_000),
    ]),
  });
  const result = (await response.json()) as OpenAIReasoningResponse & {
    error?: { message?: string };
  };
  if (!response.ok)
    throw new Error(
      `OpenAI Responses HTTP ${response.status}: ${result.error?.message ?? response.statusText}`,
    );
  return result;
}

/** Counts with the free input-token endpoint and generates with the Responses API, keeping encrypted reasoning. */
export function createOpenAIAdapter(
  options: ProviderAdapterOptions,
): ProviderAdapter {
  const { apiKey, modelId, reasoningLevel } = options;
  return {
    countTokens: createOpenAICounter({ apiKey, modelId }),
    supportsInput: supportsOpenAIInput,
    invokeModel: async (input, { signal }) => {
      const response = await generateOpenAIReasoning(input, {
        apiKey,
        modelId,
        ...(signal ? { signal } : {}),
        ...(reasoningLevel ? { effort: reasoningLevel } : {}),
      });
      // An incomplete response ends the conversation; it was still generated and billed.
      return {
        messages:
          response.status === "completed"
            ? [openaiReasoningMessage(response.output)]
            : null,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
      };
    },
  };
}
