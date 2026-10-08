import type { ProfileField } from "@tokenxl/count";
import { DEFAULT_PROFILE } from "@tokenxl/count";

/** The structural costs: every numeric profile field except the text scale, the reasoning costs and the image geometry. */
export const STRUCTURAL_FIELDS: ProfileField[] = (
  Object.keys(DEFAULT_PROFILE) as ProfileField[]
).filter(
  (field) =>
    typeof DEFAULT_PROFILE[field] === "number" &&
    field !== "contentMultiplier" &&
    field !== "perReasoningPayloadChar" &&
    field !== "reasoningPayloadEnvelopeChars" &&
    field !== "perStoredReasoning" &&
    field !== "storedReasoningSummaryScale" &&
    !/^image[A-Z]/.test(field),
);

/** Every structural cost set to zero. */
export const ZERO_COSTS: Record<string, number> = Object.fromEntries(
  STRUCTURAL_FIELDS.map((field) => [field, 0]),
);
