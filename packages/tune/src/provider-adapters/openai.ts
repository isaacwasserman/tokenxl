import type { UsageInput } from "@tokenxl/count/internal";
import {
  createCapturingCounter,
  generate,
  hasLeadingSystemOnly,
  hasUnansweredToolCall,
  loadOptional,
} from "./ai-sdk.ts";
import type { ProviderAdapter, ProviderAdapterOptions } from "./types.ts";

/** OpenAI rejects reasoning without encrypted content, and tool calls without results. */
export function supportsOpenAIInput(input: UsageInput): boolean {
  const unencrypted = input.messages.some(
    (message) =>
      Array.isArray(message.content) &&
      message.content.some(
        (part) =>
          part.type === "reasoning" &&
          !part.providerOptions?.openai?.reasoningEncryptedContent,
      ),
  );
  return (
    !unencrypted && !hasUnansweredToolCall(input) && hasLeadingSystemOnly(input)
  );
}

/**
 * Counts with the free input-token endpoint and generates with the Responses
 * API, through `@ai-sdk/openai`. Nothing is stored, so reasoning items are sent
 * with their encrypted content rather than as references.
 */
export function createOpenAIAdapter(
  options: ProviderAdapterOptions,
): ProviderAdapter {
  const { apiKey, modelId, reasoningLevel } = options;
  const load = () =>
    loadOptional("@ai-sdk/openai", () => import("@ai-sdk/openai"));
  return {
    countTokens: async (input) => {
      const { createOpenAI } = await load();
      return createCapturingCounter({
        createModel: (fetch) =>
          createOpenAI({ apiKey, fetch }).responses(modelId),
        countUrl: "https://api.openai.com/v1/responses/input_tokens",
        fields: ["model", "input", "instructions", "tools", "tool_choice"],
        providerOptions: { openai: { store: false } },
        readCount: (result) => result.input_tokens,
      })(input);
    },
    supportsInput: supportsOpenAIInput,
    invokeModel: async (input, { signal }) => {
      const { createOpenAI } = await load();
      return generate(createOpenAI({ apiKey }).responses(modelId), input, {
        ...(signal ? { signal } : {}),
        providerOptions: {
          openai: {
            store: false,
            include: ["reasoning.encrypted_content"],
            reasoningSummary: "auto",
            ...(reasoningLevel ? { reasoningEffort: reasoningLevel } : {}),
          },
        },
      });
    },
  };
}
