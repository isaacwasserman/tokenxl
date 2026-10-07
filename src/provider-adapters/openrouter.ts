import type { ModelMessage, SystemModelMessage, ToolSet } from "ai";
import type { GroundTruthCounter } from "../tune/types.ts";
import { resolveJsonSchema } from "../usage/schema.ts";
import type { UsageInput } from "../usage/types.ts";
import type { ProviderAdapter, ProviderAdapterOptions } from "./types.ts";
import { MAX_OUTPUT_TOKENS } from "./types.ts";

// Optional peer dependencies, loaded only when this adapter is used.
async function loadSdk(): Promise<{
  ai: typeof import("ai");
  openrouter: typeof import("@openrouter/ai-sdk-provider");
}> {
  try {
    const [ai, openrouter] = await Promise.all([
      import("ai"),
      import("@openrouter/ai-sdk-provider"),
    ]);
    return { ai, openrouter };
  } catch (error) {
    throw new Error(
      "tokenx: The OpenRouter adapter needs the ai and @openrouter/ai-sdk-provider packages.",
      { cause: error },
    );
  }
}

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

interface ModelCapabilities {
  inputModalities: Set<string>;
  tools: boolean;
}

// Each model lists its input types and parameters; requests it cannot take are skipped.
async function fetchCapabilities(
  modelId: string,
  signal?: AbortSignal,
): Promise<ModelCapabilities> {
  const response = await fetch("https://openrouter.ai/api/v1/models", {
    signal,
  });
  if (!response.ok)
    throw new Error(`OpenRouter models HTTP ${response.status}`);
  const { data } = (await response.json()) as {
    data: {
      id: string;
      architecture?: { input_modalities?: string[] };
      supported_parameters?: string[];
    }[];
  };
  const model = data.find((entry) => entry.id === modelId);
  if (!model)
    throw new TypeError(`tokenx: OpenRouter has no model ${modelId}.`);
  return {
    inputModalities: new Set(model.architecture?.input_modalities ?? ["text"]),
    tools: model.supported_parameters?.includes("tools") ?? false,
  };
}

/**
 * Whether a model can take a request: OpenRouter's upstream providers reject
 * tool calls without results, models accept only their listed input types, and
 * the AI SDK takes system messages only before the conversation.
 */
export function supportsOpenRouterInput(
  input: UsageInput,
  capabilities: ModelCapabilities,
): boolean {
  if (toPrompt(input).messages.some((message) => message.role === "system"))
    return false;
  const parts = input.messages.flatMap((message) =>
    Array.isArray(message.content)
      ? (message.content as {
          type: string;
          toolCallId?: string;
          mediaType?: string;
        }[])
      : [],
  );
  const results = new Set(
    parts.flatMap((part) =>
      part.type === "tool-result" ? [part.toolCallId] : [],
    ),
  );
  if (
    parts.some(
      (part) => part.type === "tool-call" && !results.has(part.toolCallId),
    )
  )
    return false;
  if (
    !capabilities.tools &&
    (Object.keys(input.tools ?? {}).length ||
      parts.some((part) => part.type === "tool-call"))
  )
    return false;
  const image = (part: { type: string; mediaType?: string }): boolean =>
    part.type === "image" ||
    (part.type === "file" && /^image(?:\/|$)/.test(part.mediaType ?? ""));
  if (parts.some(image) && !capabilities.inputModalities.has("image"))
    return false;
  return (
    !parts.some((part) => part.type === "file" && !image(part)) ||
    capabilities.inputModalities.has("file")
  );
}

/**
 * OpenRouter has no counting endpoint: each count is a 1-token generation
 * whose reported prompt tokens are the upstream model's native count. The
 * prompt is billed. Settings a provider rejects fall back in order.
 */
export function createOpenRouterCounter(
  options: ProviderAdapterOptions,
): GroundTruthCounter {
  const attempts = [
    { maxOutputTokens: 1, reasoning: { effort: "none" } },
    { maxOutputTokens: 16, reasoning: { effort: "none" } },
    { maxOutputTokens: 16 },
  ];
  let first = 0;
  return async (input) => {
    const { ai, openrouter } = await loadSdk();
    const model = openrouter
      .createOpenRouter({ apiKey: options.apiKey })
      .chat(options.modelId);
    let lastError: unknown;
    for (let index = first; index < attempts.length; index++) {
      const { maxOutputTokens, reasoning } = attempts[index]!;
      try {
        const result = await ai.generateText({
          model,
          ...toPrompt(input),
          tools: toTools(ai, input.tools),
          maxOutputTokens,
          // Rate limits and transient failures are retried with backoff; rejected settings are not.
          maxRetries: 8,
          ...(reasoning
            ? { providerOptions: { openrouter: { reasoning } } }
            : {}),
        });
        if (result.usage.inputTokens === undefined)
          throw new TypeError("OpenRouter did not report prompt tokens.");
        // Later requests start from the settings this model accepted.
        first = index;
        return {
          count: result.usage.inputTokens,
          usage: {
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens ?? 0,
          },
        };
      } catch (error) {
        if (!ai.APICallError.isInstance(error) || error.statusCode !== 400)
          throw error;
        lastError = error;
      }
    }
    throw lastError;
  };
}

/** Counts and generates through OpenRouter's chat completions with the AI SDK provider. */
export function createOpenRouterAdapter(
  options: ProviderAdapterOptions,
): ProviderAdapter {
  let capabilities: Promise<ModelCapabilities> | undefined;
  const fetchOnce = (): Promise<ModelCapabilities> =>
    (capabilities ??= fetchCapabilities(options.modelId));
  return {
    countTokens: createOpenRouterCounter(options),
    supportsInput: async (input) =>
      supportsOpenRouterInput(input, await fetchOnce()),
    invokeModel: async (input, { signal }) => {
      const { ai, openrouter } = await loadSdk();
      const result = await ai.generateText({
        model: openrouter
          .createOpenRouter({ apiKey: options.apiKey })
          .chat(options.modelId),
        ...toPrompt(input),
        tools: toTools(ai, input.tools),
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        maxRetries: 8,
        ...(signal ? { abortSignal: signal } : {}),
        ...(options.reasoningLevel
          ? {
              providerOptions: {
                openrouter: {
                  reasoning: { effort: options.reasoningLevel },
                },
              },
            }
          : {}),
      });
      // An incomplete response ends the conversation; it was still generated and billed.
      return {
        messages:
          result.finishReason === "length" ? null : result.response.messages,
        usage: {
          inputTokens: result.usage.inputTokens ?? 0,
          outputTokens: result.usage.outputTokens ?? 0,
        },
      };
    },
  };
}
