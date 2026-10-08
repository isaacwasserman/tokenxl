import type { ProviderAdapter } from "../types.ts";

export type { ProviderAdapter };

export interface ProviderAdapterOptions {
  apiKey: string;
  /** The provider's model ID. */
  modelId: string;
  /** The effort of generated responses, sent as the provider's effort setting. Omitted, the model uses its default. */
  reasoningLevel?: string;
}

/** The output-token cap of each generated response, thinking included. */
export const MAX_OUTPUT_TOKENS = 4_096;
