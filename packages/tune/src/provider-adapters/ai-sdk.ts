import type { UsageInput } from "@tokenxl/count/internal";
import { resolveJsonSchema } from "@tokenxl/count/internal";
import type {
  generateText,
  LanguageModel,
  ModelMessage,
  SystemModelMessage,
  ToolSet,
} from "ai";
import type { GroundTruthCounter, ModelResponse } from "../types.ts";
import { MAX_OUTPUT_TOKENS } from "./types.ts";

type ProviderOptions = NonNullable<
  Parameters<typeof generateText>[0]["providerOptions"]
>;

/** Loads an optional peer dependency, naming it when it is missing. */
export async function loadOptional<T>(
  name: string,
  load: () => Promise<T>,
): Promise<T> {
  try {
    return await load();
  } catch (error) {
    throw new Error(`tokenxl: This adapter needs the ${name} package.`, {
      cause: error,
    });
  }
}

/** Plain JSON Schema tools, so every provider package sees the same schema. */
function toTools(
  ai: typeof import("ai"),
  tools: UsageInput["tools"],
): ToolSet | undefined {
  if (!tools || !Object.keys(tools).length) return;
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => {
      const schema = resolveJsonSchema(tool.inputSchema);
      if (!schema)
        throw new TypeError(`Cannot resolve the schema for ${name}.`);
      return [
        name,
        ai.tool({
          ...(typeof tool.description === "string"
            ? { description: tool.description }
            : {}),
          inputSchema: ai.jsonSchema(schema),
        }),
      ];
    }),
  );
}

/**
 * The AI SDK takes system content as `instructions`, separate from `messages`.
 * Leading system messages move there, each as its own system message, in order.
 */
function toPrompt(input: UsageInput): {
  instructions?: SystemModelMessage[];
  messages: ModelMessage[];
} {
  const start = input.messages.findIndex(
    (message) => message.role !== "system",
  );
  const split = start < 0 ? input.messages.length : start;
  const instructions = input.messages.slice(0, split) as SystemModelMessage[];
  return {
    ...(instructions.length ? { instructions } : {}),
    messages: input.messages.slice(split) as ModelMessage[],
  };
}

/** The AI SDK takes system messages only before the conversation. */
export function hasLeadingSystemOnly(input: UsageInput): boolean {
  return !toPrompt(input).messages.some((message) => message.role === "system");
}

/** Tool calls that no later tool result answers. */
export function hasUnansweredToolCall(input: UsageInput): boolean {
  const parts = input.messages.flatMap((message) =>
    Array.isArray(message.content)
      ? (message.content as { type: string; toolCallId?: string }[])
      : [],
  );
  const results = new Set(
    parts.flatMap((part) =>
      part.type === "tool-result" ? [part.toolCallId] : [],
    ),
  );
  return parts.some(
    (part) => part.type === "tool-call" && !results.has(part.toolCallId),
  );
}

/** Runs `generateText` on a request; returns its usage, and `null` messages unless it finished. */
export async function generate(
  model: LanguageModel,
  input: UsageInput,
  options: {
    signal?: AbortSignal;
    providerOptions?: ProviderOptions;
    maxOutputTokens?: number;
    maxRetries?: number;
  } = {},
): Promise<ModelResponse> {
  const ai = await loadOptional("ai", () => import("ai"));
  const result = await ai.generateText({
    model,
    ...toPrompt(input),
    tools: toTools(ai, input.tools),
    maxOutputTokens: options.maxOutputTokens ?? MAX_OUTPUT_TOKENS,
    // Rate limits and transient failures are retried with backoff.
    maxRetries: options.maxRetries ?? 8,
    ...(options.signal ? { abortSignal: options.signal } : {}),
    ...(options.providerOptions
      ? { providerOptions: options.providerOptions }
      : {}),
  });
  // An incomplete response ends the conversation; it was still generated and billed.
  const complete =
    result.finishReason === "stop" || result.finishReason === "tool-calls";
  return {
    messages: complete ? result.response.messages : null,
    usage: {
      inputTokens: result.usage.inputTokens ?? 0,
      outputTokens: result.usage.outputTokens ?? 0,
    },
  };
}

/**
 * Counts exactly the request the AI SDK sends. A fetch hook catches the body
 * the provider package builds for generation, keeps the fields the count
 * endpoint accepts, and sends it there instead; no generation happens.
 */
export function createCapturingCounter(options: {
  createModel: (fetch: typeof globalThis.fetch) => LanguageModel;
  countUrl: string;
  /** Request body fields the count endpoint accepts. */
  fields: readonly string[];
  providerOptions?: ProviderOptions;
  readCount: (result: Record<string, unknown>) => unknown;
}): GroundTruthCounter {
  return async (input) => {
    let count: number | undefined;
    const fetch = async (
      _url: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const response = await globalThis.fetch(options.countUrl, {
        method: "POST",
        ...(init?.headers ? { headers: init.headers } : {}),
        body: JSON.stringify(
          Object.fromEntries(
            Object.entries(body).filter(([field]) =>
              options.fields.includes(field),
            ),
          ),
        ),
        signal: AbortSignal.timeout(30_000),
      });
      const result = (await response.json()) as Record<string, unknown> & {
        error?: { message?: string };
      };
      if (!response.ok)
        throw new Error(
          `Count HTTP ${response.status}: ${result.error?.message ?? response.statusText}`,
        );
      const value = options.readCount(result);
      if (!Number.isInteger(value) || (value as number) < 0)
        throw new TypeError("The provider did not return a token count.");
      count = value as number;
      // Stops the generation request; the count is already known.
      throw new Error("tokenxl: counted");
    };
    try {
      await generate(
        options.createModel(fetch as typeof globalThis.fetch),
        input,
        {
          maxRetries: 0,
          ...(options.providerOptions
            ? { providerOptions: options.providerOptions }
            : {}),
        },
      );
    } catch (error) {
      if (count !== undefined) return count;
      throw error;
    }
    throw new Error("tokenxl: The request was not sent to the count endpoint.");
  };
}
