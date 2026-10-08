import type { UsageInput } from "@tokenxl/count";
import { createUsageEstimator, resolveProfile } from "@tokenxl/count";
import { expect, it, vi } from "vitest";
import type { TuningCorpus } from "../src/corpus.ts";
import type { TuneOptions, TuneResult } from "../src/index.ts";
import { tuneProfile } from "../src/index.ts";
import { createProbes } from "../src/probes.ts";

// Tests replace the built-in corpus with small designs and call the real tuneProfile.
const corpus = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock("../src/corpus.ts", () => ({
  get tuningCorpus() {
    return corpus.current;
  },
}));

/** Tunes with the given inputs in place of the built-in corpus. */
function tune(
  options: TuneOptions & Partial<TuningCorpus>,
): Promise<TuneResult> {
  const {
    probes = createProbes(),
    textSamples = [],
    textSelectionSamples = [],
    validationSamples = [],
    ...rest
  } = options;
  corpus.current = {
    probes,
    textSamples,
    textSelectionSamples,
    validationSamples,
  };
  return tuneProfile(rest);
}

// Even payload lengths keep the synthetic counts integral.
function signed(
  length: number,
  summary = "",
  mark = "x",
): {
  type: "reasoning";
  text: string;
  providerOptions: { anthropic: { signature: string } };
} {
  return {
    type: "reasoning",
    text: summary,
    providerOptions: { anthropic: { signature: mark.repeat(length) } },
  };
}

const zero = { perReasoningPayloadChar: 0, reasoningPayloadEnvelopeChars: 0 };
const initial = resolveProfile({
  baseOverhead: 10,
  perMessage: 5,
  ...zero,
  text: { defaultCharsPerToken: 4 },
});
// 0.5 tokens per character after a 40-character envelope.
const target = createUsageEstimator({
  ...initial,
  perReasoningPayloadChar: 0.5,
  reasoningPayloadEnvelopeChars: 40,
});
const count = (input: UsageInput): number => target.count(input);

/** A model whose responses carry `respond`'s parts, calling a tool when one is offered and not yet answered. */
function modelWith(
  respond: (input: UsageInput) => UsageInput["messages"][number]["content"],
): (input: UsageInput) => UsageInput["messages"] {
  return (input) => {
    const content = respond(input) as Exclude<
      UsageInput["messages"][number]["content"],
      string
    >;
    const last = input.messages.at(-1)!;
    if (input.tools && last.role !== "tool")
      return [
        {
          role: "assistant",
          content: [
            ...content,
            {
              type: "tool-call",
              toolCallId: "call_1",
              toolName: Object.keys(input.tools)[0]!,
              input: { id: "a" },
            },
          ],
        } as never,
      ];
    return [{ role: "assistant", content } as never];
  };
}

it("subtracts the locked cost of messages that contain only payload reasoning", async () => {
  const length = (input: UsageInput): number =>
    100 + 2 * (JSON.stringify(input).length % 211);
  // Text answers hold only their reasoning, so removing it empties the message.
  const result = await tune({
    countTokens: count,
    invokeModel: modelWith((input) => [signed(length(input))]),
  });
  expect(result.profile.perReasoningPayloadChar).toBeCloseTo(0.5, 4);
  expect(result.profile.reasoningPayloadEnvelopeChars).toBeCloseTo(40, 3);
});

it("leaves histories without payload reasoning out of the reasoning error", async () => {
  let calls = 0;
  const result = await tune({
    countTokens: count,
    invokeModel: (input) =>
      // Every third response has only plain reasoning.
      ++calls % 3 === 0
        ? modelWith(() => [
            { type: "reasoning", text: "Visible." },
            { type: "text", text: "Done." },
          ])(input)
        : fakeModel(input),
  });
  const reasoning = result.report.reasoning!;
  expect(reasoning.metrics.reasoning.after.count).toBeLessThan(
    reasoning.histories.length,
  );
  expect(result.profile.perReasoningPayloadChar).toBeCloseTo(0.5, 4);
});

it("keeps the initial costs and reports why when the histories cannot identify them", async () => {
  const defaults = resolveProfile();
  // Every payload has the same length, so blocks and characters move together.
  const collinear = await tune({
    countTokens: count,
    invokeModel: modelWith(() => [
      signed(100),
      { type: "text", text: "Done." },
    ]),
  });
  expect(collinear.report.reasoning!.reason).toBe("collinear");
  expect(collinear.profile.perReasoningPayloadChar).toBe(
    defaults.perReasoningPayloadChar,
  );
  // Costs that fall as payloads grow are impossible.
  const plain = createUsageEstimator({ ...initial, ...zero });
  const payloads = (input: UsageInput): number[] =>
    input.messages.flatMap((message) =>
      Array.isArray(message.content)
        ? message.content.flatMap((part) =>
            part.type === "reasoning" && part.providerOptions?.anthropic
              ? [(part.providerOptions.anthropic.signature as string).length]
              : [],
          )
        : [],
    );
  const invalid = await tune({
    countTokens: (input) =>
      plain.count(input) +
      payloads(input).reduce((sum, length) => sum + 400 - 0.5 * length, 0),
    invokeModel: (input) => fakeModel(input),
  });
  expect(invalid.report.reasoning!.reason).toBe("invalid");
  expect(invalid.profile.perReasoningPayloadChar).toBe(
    defaults.perReasoningPayloadChar,
  );
});

it("propagates counter errors from the reasoning phase", async () => {
  await expect(
    tune({
      countTokens: (input) => {
        if (JSON.stringify(input).includes("signature"))
          throw new Error("Counter failed");
        return count(input);
      },
      invokeModel: (input) => fakeModel(input),
    }),
  ).rejects.toThrow("Counter failed");
});

// A fake model: it calls a tool when tools are offered and no result is in yet;
// the payload length depends on the history, so lengths and block counts vary.
function fakeModel(input: UsageInput, mark = "x"): UsageInput["messages"] {
  const length = 100 + 2 * (JSON.stringify(input).length % 211);
  const last = input.messages.at(-1)!;
  if (input.tools && last.role !== "tool")
    return [
      {
        role: "assistant",
        content: [
          signed(length, "A plan.", mark),
          {
            type: "tool-call",
            toolCallId: `call_${length}`,
            toolName: Object.keys(input.tools)[0]!,
            input: { id: "a" },
          },
        ],
      },
    ];
  return [
    {
      role: "assistant",
      content: [
        signed(length, "A summary.", mark),
        { type: "text", text: `Answer ${input.messages.length}.` },
      ],
    },
  ];
}

it("tunes reasoning only when invokeModel is given", async () => {
  const withoutModel = await tune({ countTokens: count });
  expect(withoutModel.report.reasoning).toBeNull();
});

it.each([true, false])(
  "fits payload costs and whether previous turns count them (%s)",
  async (previous) => {
    const invokeModel = vi.fn((input: UsageInput) => fakeModel(input));
    const drops = createUsageEstimator({
      ...initial,
      perReasoningPayloadChar: 0.5,
      reasoningPayloadEnvelopeChars: 40,
      countReasoningInPreviousTurns: previous,
    });
    const result = await tune({
      countTokens: (input) => drops.count(input),
      invokeModel,
    });
    const reasoning = result.report.reasoning!;
    expect(reasoning.invocations).toBe(invokeModel.mock.calls.length);
    expect(
      reasoning.histories.some(
        (input) => input.messages.at(-1)!.role === "tool",
      ),
    ).toBe(true);
    expect(result.profile).toMatchObject({
      perReasoningPayloadChar: expect.closeTo(0.5, 4),
      reasoningPayloadEnvelopeChars: expect.closeTo(40, 3),
      countReasoningInPreviousTurns: previous,
    });
    expect(result.profile.perMessage).toBeCloseTo(initial.perMessage, 7);
    expect(reasoning.metrics.reasoning.after.mae).toBeCloseTo(0, 6);
  },
);

it("reports the time and billed usage of each phase and call", async () => {
  const usage = { inputTokens: 10, outputTokens: 2 };
  const result = await tune({
    countTokens: (input) => ({ count: count(input), usage }),
    invokeModel: (input) => ({ messages: fakeModel(input), usage }),
  });
  const { timing } = result.report;
  expect(timing.calls.filter((call) => call.kind === "generate")).toHaveLength(
    result.report.reasoning!.invocations,
  );
  expect(timing.calls.filter((call) => call.kind === "count")).toHaveLength(
    result.report.counterCalls,
  );
  expect(
    timing.calls.every(
      (call) =>
        call.usage === usage &&
        call.start <= call.end &&
        call.end <= timing.total,
    ),
  ).toBe(true);
  expect(timing.phases.map((phase) => `${phase.stage} ${phase.phase}`)).toEqual(
    [
      "text collect",
      "text fit",
      "overhead collect",
      "overhead fit",
      "reasoning generate",
      "reasoning fit",
    ],
  );
});

it("ends a conversation when invokeModel returns null", async () => {
  const invokeModel = vi.fn((input: UsageInput) =>
    input.messages.length > 1 ? null : fakeModel(input),
  );
  const result = await tune({
    countTokens: count,
    invokeModel,
  });
  // Every conversation keeps only its first history.
  const { histories } = result.report.reasoning!;
  expect(histories.length).toBeLessThan(result.report.reasoning!.invocations);
  expect(
    histories.every(
      (input) =>
        input.messages.filter((message) => message.role === "assistant")
          .length === 1,
    ),
  ).toBe(true);
});

it("does not invoke the model when an earlier phase fails, and stops on a model error", async () => {
  const invokeModel = vi.fn((input: UsageInput) => fakeModel(input));
  await expect(
    tune({
      countTokens: () => {
        throw new Error("Counter failed");
      },
      invokeModel,
    }),
  ).rejects.toThrow("Counter failed");
  expect(invokeModel).not.toHaveBeenCalled();
  const failing = vi.fn(async () => {
    throw new Error("Model failed");
  });
  await expect(
    tune({
      countTokens: count,
      invokeModel: failing,
      concurrency: 1,
    }),
  ).rejects.toThrow("Model failed");
  expect(failing).toHaveBeenCalledTimes(1);
});

it("keeps the initial reasoning costs when the model does not reason", async () => {
  const plain = (input: UsageInput): UsageInput["messages"] => [
    { role: "assistant", content: `Answer ${input.messages.length}.` },
  ];
  const result = await tune({
    countTokens: count,
    invokeModel: plain,
  });
  expect(result.report.reasoning!.reason).toBe("absent");
  expect(result.profile.perReasoningPayloadChar).toBe(
    resolveProfile().perReasoningPayloadChar,
  );
});

it("fits stored OpenAI reasoning costs from the generated items' payloads and summaries", async () => {
  let calls = 0;
  const result = await tune({
    countTokens: count,
    // Odd responses summarize in `n` one-token words and hide 3 tokens per
    // summary token; even responses have no summary and hide 50 tokens.
    invokeModel: modelWith(() => {
      const n = ++calls;
      const summarized = n % 2 === 1;
      return [
        {
          type: "reasoning",
          text: summarized ? Array(n).fill("word").join(" ") : "",
          providerOptions: {
            openai: {
              itemId: `rs_${n}`,
              reasoningEncryptedContent: "x".repeat(
                40 + (summarized ? 6 * n : 100),
              ),
            },
          },
        },
      ];
    }),
  });
  const { storedReasoning } = result.report.reasoning!;
  expect(storedReasoning.summarized).toBeGreaterThan(0);
  expect(storedReasoning.items).toBeGreaterThan(storedReasoning.summarized);
  expect(result.profile.storedReasoningSummaryScale).toBeCloseTo(3, 3);
  expect(result.profile.perStoredReasoning).toBeCloseTo(50, 3);
});
