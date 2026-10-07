import type { ResolvedModelProfile } from "../profile.ts";
import { compileProfile } from "../profile.ts";
import { tallyUsage } from "../usage/estimator.ts";
import type { UsageInput } from "../usage/types.ts";

/** Extract the exact same text occurrences that the estimator charges. */
export function extractChargedTexts(
  inputs: readonly UsageInput[],
  initial: ResolvedModelProfile,
): { inputs: UsageInput[]; parts: string[][] } {
  const compiled = compileProfile(initial);
  const unique = new Map<string, UsageInput>();
  const parts = inputs.map((input) => {
    const occurrences: string[] = [];
    tallyUsage(input, compiled, {}, (text) => {
      occurrences.push(text);
      if (!unique.has(text))
        unique.set(text, { messages: [{ role: "user", content: text }] });
      return 0;
    });
    return occurrences;
  });
  return { inputs: [...unique.values()], parts };
}
