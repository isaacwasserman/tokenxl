import { createAnthropicAdapter } from "./anthropic.ts";
import { createOpenAIAdapter } from "./openai.ts";
import { createOpenRouterAdapter } from "./openrouter.ts";
import type { ProviderAdapter, ProviderAdapterOptions } from "./types.ts";

export type { ProviderAdapter, ProviderAdapterOptions } from "./types.ts";

export type ProviderName = "anthropic" | "openai" | "openrouter";

const adapters: Record<
  ProviderName,
  (options: ProviderAdapterOptions) => ProviderAdapter
> = {
  anthropic: createAnthropicAdapter,
  openai: createOpenAIAdapter,
  openrouter: createOpenRouterAdapter,
};

export const PROVIDER_NAMES: readonly ProviderName[] = Object.keys(
  adapters,
) as ProviderName[];

/**
 * Creates the counter and model invoker for a provider. Pass the result to
 * the tuner: `tuneProfile(createProviderAdapter('anthropic', options))`.
 */
export function createProviderAdapter(
  provider: ProviderName,
  options: ProviderAdapterOptions,
): ProviderAdapter {
  if (!Object.hasOwn(adapters, provider))
    throw new TypeError(
      `tokenx: Unknown provider ${provider}; expected one of ${PROVIDER_NAMES.join(", ")}.`,
    );
  return adapters[provider](options);
}

/**
 * The registry key of a provider's model ID: `provider/model`, with a dated
 * snapshot suffix removed and version separators written as dots, as OpenRouter
 * writes them. `claude-sonnet-4-5-20250929` becomes `anthropic/claude-sonnet-4.5`
 * and `gpt-5.1-2025-11-13` becomes `openai/gpt-5.1`. OpenRouter IDs are already keys.
 */
export function getModelKey(provider: ProviderName, modelId: string): string {
  const key = modelId.includes("/") ? modelId : `${provider}/${modelId}`;
  return key
    .replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2})$/, "")
    .replace(/(?<=\D-\d{1,2})-(?=\d{1,2}(?:-|$))/g, ".");
}
