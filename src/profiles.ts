import type { ModelProfile } from "./profile.ts";
import registry from "./profiles.json" with { type: "json" };

// Profiles calibrated against each provider's input-token counts, keyed as provider/model.
const entries: Record<string, ModelProfile> = registry satisfies Record<
  string,
  ModelProfile
>;

export type ModelId = keyof typeof registry;

export type ModelProfileInput = ModelId | ModelProfile;

/** The profile of each predefined model. */
export const MODEL_PROFILES: {
  readonly [Model in ModelId]: Readonly<ModelProfile>;
} = entries as never;

// Shared profiles must stay immutable because estimators reuse their compiled costs.
for (const profile of Object.values(entries)) {
  if (profile.text) {
    Object.freeze(profile.text.languageCharsPerToken);
    Object.freeze(profile.text.unaccentedWordScale);
    Object.freeze(profile.text);
  }
  Object.freeze(profile);
}
Object.freeze(MODEL_PROFILES);

/** Resolve a predefined ID, preserving custom objects for estimator reuse. */
export function selectProfile(
  profile?: ModelProfileInput,
): ModelProfile | undefined {
  if (typeof profile !== "string") return profile;
  if (!Object.hasOwn(MODEL_PROFILES, profile))
    throw new TypeError(`tokenx: No predefined profile for model ${profile}.`);
  return MODEL_PROFILES[profile];
}
