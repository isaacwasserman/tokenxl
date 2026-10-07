import type { GroundTruthCounter } from "../tune/types.ts";
import type { UsageInput } from "../usage/types.ts";
import {
  generate,
  hasLeadingSystemOnly,
  hasUnansweredToolCall,
  loadOptional,
} from "./ai-sdk.ts";
import type { ProviderAdapter, ProviderAdapterOptions } from "./types.ts";

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
  if (!hasLeadingSystemOnly(input) || hasUnansweredToolCall(input))
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
    const [{ APICallError }, model] = await Promise.all([
      loadOptional("ai", () => import("ai")),
      createModel(options),
    ]);
    let lastError: unknown;
    for (let index = first; index < attempts.length; index++) {
      const { maxOutputTokens, reasoning } = attempts[index]!;
      try {
        const { usage } = await generate(model, input, {
          maxOutputTokens,
          ...(reasoning
            ? { providerOptions: { openrouter: { reasoning } } }
            : {}),
        });
        // Later requests start from the settings this model accepted.
        first = index;
        return { count: usage!.inputTokens, usage: usage! };
      } catch (error) {
        if (!APICallError.isInstance(error) || error.statusCode !== 400)
          throw error;
        lastError = error;
      }
    }
    throw lastError;
  };
}

async function createModel(options: ProviderAdapterOptions) {
  const { createOpenRouter } = await loadOptional(
    "@openrouter/ai-sdk-provider",
    () => import("@openrouter/ai-sdk-provider"),
  );
  return createOpenRouter({ apiKey: options.apiKey }).chat(options.modelId);
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
    invokeModel: async (input, { signal }) =>
      generate(await createModel(options), input, {
        ...(signal ? { signal } : {}),
        ...(options.reasoningLevel
          ? {
              providerOptions: {
                openrouter: { reasoning: { effort: options.reasoningLevel } },
              },
            }
          : {}),
      }),
  };
}
