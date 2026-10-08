import type { ModelMessage, ToolSet } from "ai";
import { jsonSchema, tool } from "ai";
import type { UsageBreakdown, UsageInput } from "../src/index";
import { createUsageEstimator } from "../src/index";

const messages: ModelMessage[] = [
  { role: "system", content: "Be brief." },
  { role: "user", content: [{ type: "text", text: "Hello" }] },
];
const tools: ToolSet = {
  lookup: tool({
    inputSchema: jsonSchema({
      type: "object",
      properties: { id: { type: "string" } },
    }),
  }),
};
const input: UsageInput = { messages, tools };
const estimator = createUsageEstimator();

export const count: number = estimator.count(input);
export const breakdown: UsageBreakdown = estimator.count(input, {
  breakdown: true,
});
export const optionalBreakdown: number | UsageBreakdown = estimator.count(
  input,
  { breakdown: Math.random() > 0.5 },
);

export const textCount: number = estimator.count({ text: "Hello" });
// A breakdown needs a request with messages.
// @ts-expect-error
estimator.count({ text: "Hello" }, { breakdown: true });

export const fits: boolean = estimator.isWithinTokenLimit(
  { text: "Hello" },
  10,
);
export const fitsRequest: boolean = estimator.isWithinTokenLimit(input, 10);
export const slice: string = estimator.sliceByTokens("Hello", 0, 1);
export const chunks: string[] = estimator.splitByTokens("Hello", 1, {
  overlap: 0,
});
