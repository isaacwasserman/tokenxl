import type { UsageInput } from "@tokenxl/count/internal";
import {
  createCapturingCounter,
  generate,
  hasLeadingSystemOnly,
  loadOptional,
} from "./ai-sdk.ts";
import type { ProviderAdapter, ProviderAdapterOptions } from "./types.ts";

/** Anthropic rejects reasoning without a signature or redacted data, and requests that end with an assistant message. */
export function supportsAnthropicInput(input: UsageInput): boolean {
  const unsigned = input.messages.some(
    (message) =>
      Array.isArray(message.content) &&
      message.content.some(
        (part) =>
          part.type === "reasoning" &&
          !part.providerOptions?.anthropic?.signature &&
          !part.providerOptions?.anthropic?.redactedData,
      ),
  );
  // A trailing assistant message would be a prefill, which current models reject.
  const prefill = input.messages.at(-1)?.role === "assistant";
  return !unsigned && !prefill && hasLeadingSystemOnly(input);
}

/** Counts with the free CountTokens endpoint and generates with the Messages API, through `@ai-sdk/anthropic`. */
export function createAnthropicAdapter(
  options: ProviderAdapterOptions,
): ProviderAdapter {
  const { apiKey, modelId, reasoningLevel } = options;
  const load = () =>
    loadOptional("@ai-sdk/anthropic", () => import("@ai-sdk/anthropic"));
  return {
    countTokens: async (input) => {
      const { createAnthropic } = await load();
      return createCapturingCounter({
        createModel: (fetch) => createAnthropic({ apiKey, fetch })(modelId),
        countUrl: "https://api.anthropic.com/v1/messages/count_tokens",
        fields: ["model", "messages", "system", "tools", "tool_choice"],
        readCount: (result) => result.input_tokens,
      })(input);
    },
    supportsInput: supportsAnthropicInput,
    invokeModel: async (input, { signal }) => {
      const { createAnthropic } = await load();
      // Without a level, the request sets no thinking, so the model uses its defaults.
      return generate(createAnthropic({ apiKey })(modelId), input, {
        ...(signal ? { signal } : {}),
        ...(reasoningLevel
          ? {
              providerOptions: {
                anthropic: {
                  thinking: { type: "adaptive" },
                  effort: reasoningLevel,
                },
              },
            }
          : {}),
      });
    },
  };
}
