import { createUsageEstimator } from "@tokenxl/count";
import { expect, it } from "vitest";
import { tuningCorpus } from "../src/corpus.ts";
import { tuneProfile } from "../src/index.ts";

it("tunes on the built-in corpus without being given inputs", async () => {
  const target = createUsageEstimator({ perMessage: 7 });
  const result = await tuneProfile({
    countTokens: (input) => target.count(input),
  });
  // Only the corpus supplies natural text, selection documents, and validation requests.
  expect(result.report.text.composition).not.toBeNull();
  expect(result.report.validation?.after.count).toBe(
    tuningCorpus.validationSamples.length,
  );
  expect(result.profile.perMessage).toBe(7);
}, 60_000);
