import { expect, it, vi } from "vitest";
import type { UsageInput } from "../src/index.ts";
import { createUsageEstimator, resolveProfile } from "../src/index.ts";
import { tuneProfile } from "../src/tune/calibrate.ts";
import type { TuningCorpus } from "../src/tune/corpus.ts";
import { createProbes } from "../src/tune/probes.ts";
import {
  fitReasoning,
  REASONING_INVOCATIONS,
  removeReasoningPayloads,
} from "../src/tune/reasoning.ts";
import type { TuneOptions, TuneResult } from "../src/tune/types.ts";

// Tests replace the built-in corpus with small designs and call the real tuneProfile.
const corpus = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock("../src/tune/corpus.ts", () => ({
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

/** Reasoning in an earlier turn: a user message follows it. */
function history(payloads: number[], answer = "An answer."): UsageInput {
  return {
    messages: [
      { role: "user", content: "A question." },
      {
        role: "assistant",
        content: [
          ...payloads.map((length) => signed(length, "A visible summary.")),
          { type: "text", text: answer },
        ],
      },
      { role: "user", content: "Continue." },
    ],
  };
}

/** Reasoning in the current turn: the history ends with its tool result. */
function toolLoop(payloads: number[]): UsageInput {
  return {
    messages: [
      { role: "user", content: "Look it up." },
      {
        role: "assistant",
        content: [
          ...payloads.map((length) => signed(length)),
          {
            type: "tool-call",
            toolCallId: "call_1",
            toolName: "lookup",
            input: { id: "a" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_1",
            toolName: "lookup",
            output: { type: "json", value: { found: true } },
          },
        ],
      },
    ],
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

it("fits costs from earlier-turn reasoning with text rules and structure locked", async () => {
  const samples = [
    history([100]),
    history([400]),
    history([200, 300]),
    history([60, 80, 1000], "A longer and different answer."),
  ];
  const countTokens = vi.fn(count);
  const result = await fitReasoning(samples, initial, { countTokens });
  expect(result.reason).toBeUndefined();
  // Without current-turn histories, only the kept case can be fitted, so it is not a measurement.
  expect(result.histories).toEqual({ currentTurn: 0, previousTurns: 4 });
  expect(result.profile).toEqual({
    ...initial,
    perReasoningPayloadChar: expect.closeTo(0.5, 10),
    reasoningPayloadEnvelopeChars: expect.closeTo(40, 8),
    countReasoningInPreviousTurns: true,
  });
  expect(result.metrics.reasoning.after.mae).toBeCloseTo(0, 10);
  expect(result.metrics.request.after.mae).toBe(0);
  expect(result.metrics.reasoning.before.mae).toBeGreaterThan(0);
  // Each history is counted with and without its payload parts.
  expect(countTokens).toHaveBeenCalledTimes(samples.length * 2);
});

it("chooses dropped earlier-turn reasoning when the counts show it costs nothing", async () => {
  const drops = createUsageEstimator({
    ...initial,
    perReasoningPayloadChar: 0.5,
    reasoningPayloadEnvelopeChars: 40,
    countReasoningInPreviousTurns: false,
  });
  const samples = [
    history([100]),
    history([400]),
    history([200, 300]),
    toolLoop([100]),
    toolLoop([600]),
    toolLoop([200, 300]),
  ];
  const result = await fitReasoning(samples, initial, {
    countTokens: (input) => drops.count(input),
  });
  expect(result.reason).toBeUndefined();
  expect(result.histories).toEqual({ currentTurn: 3, previousTurns: 3 });
  expect(result.profile).toMatchObject({
    perReasoningPayloadChar: expect.closeTo(0.5, 10),
    reasoningPayloadEnvelopeChars: expect.closeTo(40, 8),
    countReasoningInPreviousTurns: false,
  });
  expect(result.metrics.reasoning.after.mae).toBeCloseTo(0, 10);
});

it("subtracts the locked cost of messages that contain only payload reasoning", async () => {
  const onlyThinking = (length: number): UsageInput => ({
    messages: [
      { role: "user", content: "A question." },
      { role: "assistant", content: [signed(length)] },
      { role: "user", content: "Continue." },
    ],
  });
  expect(removeReasoningPayloads(onlyThinking(10)).messages).toHaveLength(2);
  const result = await fitReasoning(
    [onlyThinking(100), onlyThinking(300), history([200, 400])],
    initial,
    { countTokens: count },
  );
  expect(result.profile.reasoningPayloadEnvelopeChars).toBeCloseTo(40, 8);
  expect(result.profile.perReasoningPayloadChar).toBeCloseTo(0.5, 10);
});

it("returns histories without payload reasoning unchanged and counts them once", async () => {
  const plain: UsageInput = {
    messages: [
      { role: "user", content: "Plain." },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "Visible." },
          { type: "text", text: "Done." },
        ],
      },
      { role: "user", content: "Next." },
    ],
  };
  expect(removeReasoningPayloads(plain)).toBe(plain);
  const countTokens = vi.fn(count);
  const result = await fitReasoning(
    [history([100]), history([200, 600]), plain],
    initial,
    { countTokens },
  );
  expect(countTokens).toHaveBeenCalledTimes(5);
  // Only histories with payload reasoning enter the reasoning metrics.
  expect(result.metrics.reasoning.after.count).toBe(2);
});

it("keeps the initial costs and reports why when the data cannot identify them", async () => {
  const collinear = await fitReasoning(
    [history([100]), history([100, 100])],
    initial,
    { countTokens: count },
  );
  expect(collinear.reason).toBe("collinear");
  expect(collinear.profile).toEqual(initial);
  const absent = await fitReasoning(
    [history([]), history([], "Other.")],
    initial,
    { countTokens: count },
  );
  expect(absent.reason).toBe("absent");
  expect(absent.profile).toEqual(initial);
  // Costs that fall as payloads grow are impossible.
  const plain = createUsageEstimator({ ...initial, ...zero });
  const falling = (input: UsageInput): number =>
    plain.count(input) +
    input.messages.reduce(
      (sum, message) =>
        sum +
        (Array.isArray(message.content)
          ? message.content.reduce(
              (total, part) =>
                part.type === "reasoning"
                  ? total +
                    400 -
                    0.5 *
                      (part.providerOptions!.anthropic!.signature as string)
                        .length
                  : total,
              0,
            )
          : 0),
      0,
    );
  const invalid = await fitReasoning(
    [history([100]), history([300]), history([200, 400])],
    initial,
    { countTokens: falling },
  );
  expect(invalid.reason).toBe("invalid");
  expect(invalid.profile).toEqual(initial);
});

it("propagates counter errors rather than fitting incomplete reasoning data", async () => {
  await expect(
    fitReasoning([history([100]), history([200, 300])], initial, {
      countTokens: () => {
        throw new Error("Counter failed");
      },
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

it("tunes reasoning only when invokeModel is given, after the free phases, with current-turn tool loops", async () => {
  const withoutModel = await tune({ countTokens: count });
  expect(withoutModel.report.reasoning).toBeNull();

  const invokeModel = vi.fn((input: UsageInput) => fakeModel(input));
  const drops = createUsageEstimator({
    ...initial,
    perReasoningPayloadChar: 0.5,
    reasoningPayloadEnvelopeChars: 40,
    countReasoningInPreviousTurns: false,
  });
  const result = await tune({
    countTokens: (input) => drops.count(input),
    invokeModel,
  });
  expect(invokeModel).toHaveBeenCalledTimes(REASONING_INVOCATIONS);
  const reasoning = result.report.reasoning!;
  expect(reasoning.invocations).toBe(REASONING_INVOCATIONS);
  expect(
    reasoning.histories.some((input) => input.messages.at(-1)!.role === "tool"),
  ).toBe(true);
  expect(reasoning.countReasoningInPreviousTurns).toBe(false);
  expect(result.profile).toMatchObject({
    perReasoningPayloadChar: expect.closeTo(0.5, 4),
    reasoningPayloadEnvelopeChars: expect.closeTo(40, 3),
    countReasoningInPreviousTurns: false,
  });
  expect(result.profile.perMessage).toBeCloseTo(initial.perMessage, 7);
  expect(reasoning.metrics.reasoning.after.mae).toBeCloseTo(0, 6);
});

it("reports the time and billed usage of each phase and call", async () => {
  const usage = { inputTokens: 10, outputTokens: 2 };
  const result = await tune({
    countTokens: (input) => ({ count: count(input), usage }),
    invokeModel: (input) => ({ messages: fakeModel(input), usage }),
  });
  const { timing } = result.report;
  expect(timing.calls.filter((call) => call.kind === "generate")).toHaveLength(
    REASONING_INVOCATIONS,
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
  expect(histories.length).toBeLessThan(REASONING_INVOCATIONS);
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
