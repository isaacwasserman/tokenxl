import type { ProfileField } from "../../src/index.ts";
import { DEFAULT_PROFILE } from "../../src/index.ts";

/** The structural costs: every numeric profile field except the text scale and the reasoning payload costs. */
export const STRUCTURAL_FIELDS: ProfileField[] = (
  Object.keys(DEFAULT_PROFILE) as ProfileField[]
).filter(
  (field) =>
    typeof DEFAULT_PROFILE[field] === "number" &&
    field !== "contentMultiplier" &&
    field !== "perReasoningPayloadChar" &&
    field !== "reasoningPayloadEnvelopeChars",
);

/** Every structural cost set to zero. */
export const ZERO_COSTS: Record<string, number> = Object.fromEntries(
  STRUCTURAL_FIELDS.map((field) => [field, 0]),
);
