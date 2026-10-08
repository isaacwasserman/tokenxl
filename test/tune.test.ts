import { jsonSchema } from "ai";
import { describe, expect, it, vi } from "vitest";
import type { TextProfile, UsageInput } from "../src/index.ts";
import {
  createUsageEstimator,
  DEFAULT_TEXT_PROFILE,
  resolveProfile,
} from "../src/index.ts";
import type { TuningCorpus } from "../src/tune/corpus.ts";
import type {
  TuneOptions,
  TuneProgress,
  TuneResult,
} from "../src/tune/index.ts";
import { tuneProfile } from "../src/tune/index.ts";
import { createProbes } from "../src/tune/probes.ts";
import { STRUCTURAL_FIELDS } from "./fixtures/profile-fields.ts";

// Tests replace the built-in corpus with small designs and call the real tuneProfile.
const corpus = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock("../src/tune/corpus.ts", () => ({
  get tuningCorpus() {
    return corpus.current;
  },
}));

const textRules = (text?: TextProfile) => resolveProfile({ text }).text;

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

describe("tuneProfile", () => {
  it("refines natural text with measured scale and structural coefficients fixed", async () => {
    const probes = createProbes();
    probes.textRules = [];
    const target = createUsageEstimator({
      contentMultiplier: 2,
      baseOverhead: 10_000,
      perMessage: 7,
      perInteger: 3,
      text: { digitsPerToken: 2 },
    });
    const request = (content: string): UsageInput => ({
      messages: [{ role: "user", content }],
    });
    const result = await tune({
      probes,
      textSamples: ["12345678901234567890", "123456 789012 345678"].map(
        request,
      ),
      textSelectionSamples: ["99999999 22222222"].map(request),
      countTokens: (input) => target.count(input),
    });
    expect(result.report.text.composition!.train.after.mape).toBe(0);
    expect(result.report.text.composition!.selection!.after.mape).toBe(0);
    expect(result.report.text.composition!.train.before.mape).toBeGreaterThan(
      0,
    );
    expect(result.profile.contentMultiplier).toBeCloseTo(2, 10);
    for (const field of STRUCTURAL_FIELDS)
      expect(result.profile[field], field).toBeCloseTo(
        target.profile[field],
        8,
      );
    expect(result.report.overhead.contrasts.exactFraction).toBe(1);
    expect(
      result.report.fields.find(
        (field) => field.field === "text.digitsPerToken",
      )!.identifiable,
    ).toBe(true);
  });

  it("finds narrow ratio intervals and accounts for mixed-script rounding offsets", async () => {
    for (const example of [
      {
        text: { digitsPerToken: 2.013 },
        initial: { digitsPerToken: 2 },
        inputs: [47, 311, 1050].map((n) => "1".repeat(n)),
      },
      {
        text: { hanziCharsPerToken: 1.381 },
        initial: { hanziCharsPerToken: 1.4 },
        inputs: [47, 97, 211].map(
          (n) =>
            "界".repeat(n) +
            "か".repeat((n % 7) + 1) +
            "한".repeat((n % 3) + 1),
        ),
      },
    ]) {
      const target = createUsageEstimator({
        contentMultiplier: 2,
        text: example.text,
      });
      const inputs: UsageInput[] = example.inputs.map((content) => ({
        messages: [{ role: "user", content }],
      }));
      const probes = createProbes();
      probes.textRules = [];
      // The refinement stays near its start unless the text supports a
      // move, so the search starts near the target interval.
      const { profile: fitted } = await tune({
        probes,
        initial: { text: example.initial },
        textSamples: inputs,
        countTokens: (input) => target.count(input),
      });
      const estimator = createUsageEstimator(fitted);
      expect(inputs.map((input) => estimator.count(input))).toEqual(
        inputs.map((input) => target.count(input)),
      );
      expect(fitted.contentMultiplier).toBe(2);
    }
  });

  it("keeps the initial text rules when a refinement improves training but harms selection", async () => {
    const probes = createProbes();
    probes.textRules = [];
    const request = (content: string): UsageInput => ({
      messages: [{ role: "user", content }],
    });
    const selection = request("999999999999999999");
    const target = createUsageEstimator({
      contentMultiplier: 2,
      text: { digitsPerToken: 2 },
    });
    const selectionTarget = createUsageEstimator({
      contentMultiplier: 2,
      text: { digitsPerToken: 3 },
    });
    const result = await tune({
      probes,
      textSamples: ["123456789012345678", "111111111111111111"].map(request),
      textSelectionSamples: [selection],
      countTokens: (input) =>
        (input === selection ? selectionTarget : target).count(input),
    });
    // The probe calibration equals the initial rules here, so the initial rules are kept.
    expect(result.report.text.composition!.selected).toBe("initial");
    expect(result.report.text.composition!.selection!.after.loss).toBe(0);
    expect(result.profile.text).toEqual(DEFAULT_TEXT_PROFILE);
  });

  it("reports context residuals separately without changing controlled overheads", async () => {
    const probes = createProbes();
    const before: UsageInput = {
      messages: [{ role: "user", content: "a alpha" }],
    };
    const after: UsageInput = {
      messages: [{ role: "user", content: "a bravo" }],
    };
    probes.textContext = [{ before, after }];
    const target = createUsageEstimator({ contentMultiplier: 2 });
    const result = await tune({
      probes,
      countTokens: (input) => target.count(input) + (input === after ? 4 : 0),
    });
    expect(result.report.text.context).toMatchObject({
      count: 1,
      rmse: 4,
      maxError: 4,
      meanError: -4,
    });
    expect(result.report.overhead.contrasts.exactFraction).toBe(1);
  });

  it("separates a large text intercept from the multiplier and recovers every controlled overhead", async () => {
    const target = createUsageEstimator({
      contentMultiplier: 2,
      baseOverhead: 100_000,
      perMessage: 7,
      perSystem: 3,
      toolsExist: 55,
      perTool: 13,
      perDesc: 4,
      perFirstProp: 10,
      perAdditionalProp: 6,
      perPropDesc: 3,
      perEnum: 11,
      perNestedObject: -1,
      perArrayOfObjects: 5,
      perToolCall: 7,
      perToolResult: 5,
      perParallelToolCalls: 9,
      perImage: 125,
      perImagePatch: 2,
      perToolResultImage: 10,
      imagePatchSize: 32,
      perFile: 170,
      perReasoning: 4,
      perEnumValue: 3,
      perRequired: 6,
      perRequiredProp: 2,
      perAdditionalProperties: 10,
      perInteger: 1,
      perBoolean: 2,
      perArrayOfPrimitives: 12,
      perAdditionalPropertiesTrue: 9,
    });
    const result = await tune({
      countTokens: (input) => target.count(input),
    });
    expect(result.report.text.multiplier).toBeCloseTo(2, 10);
    expect(result.report.text.intercept).toBeCloseTo(100_007, 8);
    expect(result.report.text.rSquared).toBeCloseTo(1, 10);
    expect(result.report.overhead.rank).toBe(STRUCTURAL_FIELDS.length);
    // Reasoning costs are measured only with invokeModel.
    expect(result.report.reasoning).toBeNull();
    expect(
      result.report.fields.some(
        (report) => report.field === "perReasoningPayloadChar",
      ),
    ).toBe(false);
    for (const field of STRUCTURAL_FIELDS) {
      expect(result.profile[field], field).toBeCloseTo(
        target.profile[field],
        7,
      );
      expect(
        result.report.fields.find((report) => report.field === field)!
          .identifiable,
      ).toBe(true);
    }
    expect(textRules(result.profile.text)).toEqual(
      textRules(target.profile.text),
    );
    expect(
      result.report.text.rules.every(
        (field) =>
          field.identifiable ||
          field.field.startsWith("text.unaccentedWordScale."),
      ),
    ).toBe(true);
    expect(result.profile.imagePatchSize).toBe(32);
    expect(result.report.overhead.after.loss).toBe(0);
    const restored = createUsageEstimator(
      JSON.parse(JSON.stringify(result.profile)),
    );
    const independent: UsageInput = {
      messages: [
        { role: "user", content: "A completely independent request." },
      ],
    };
    expect(restored.count(independent)).toBe(target.count(independent));
  });

  it("locks the entire measured text profile even when overhead requests have conflicting text costs", async () => {
    const probes = createProbes({
      texts: ["Natural language about records and libraries."],
    });
    const target = createUsageEstimator({
      contentMultiplier: 2,
      baseOverhead: 900,
      perMessage: 30,
    });
    const initial = {
      text: { digitsPerToken: 4, languageCharsPerToken: { german: 2.5 } },
    };
    const control = await tune({
      initial,
      probes,
      countTokens: (input) => target.count(input),
    });
    let stage: TuneProgress["stage"] = "text";
    const result = await tune({
      initial,
      probes,
      countTokens: (input) => target.count(input) * (stage === "text" ? 1 : 5),
      onProgress: (event) => {
        if (event.stage === "text" && event.phase === "fit") stage = "overhead";
      },
    });
    expect(result.profile.contentMultiplier).toBeCloseTo(2, 10);
    expect(result.report.text.intercept).toBeCloseTo(930, 10);
    expect(result.profile.text).toEqual(control.profile.text);
    expect(result.profile.perMessage).not.toBeCloseTo(30);
  });

  it("uses directly measured fragment costs so text errors do not bias overhead coefficients", async () => {
    const target = createUsageEstimator({
      contentMultiplier: 2,
      baseOverhead: 6,
      perMessage: 2,
      perPropDesc: 5,
      text: { lowercaseWordMaxLength: 6, defaultCharsPerToken: 2.2 },
    });
    const result = await tune({
      countTokens: (input) => {
        // The ground truth gives this word one token although the heuristic
        // prices it at four. Correct each occurrence in every request context.
        const occurrences =
          JSON.stringify(input).match(/\brecords\b/g)?.length ?? 0;
        return target.count(input) - 6 * occurrences;
      },
    });
    for (const field of STRUCTURAL_FIELDS)
      expect(result.profile[field], field).toBeCloseTo(
        target.profile[field],
        8,
      );
    expect(result.report.overhead.contrasts.maxError).toBeLessThan(1e-7);
    expect(result.report.overhead.contrasts.exactFraction).toBe(1);
    expect(result.report.text.overheadTextSamples).toBeGreaterThan(0);
  });

  it("measures individual script, language and numeric rules from their labeled contrasts", async () => {
    const target = createUsageEstimator({
      contentMultiplier: 2,
      text: {
        defaultCharsPerToken: 4,
        digitsPerToken: 2,
        hanziCharsPerToken: 2,
        kanaCharsPerToken: 2,
        hangulCharsPerToken: 2,
        languageCharsPerToken: {
          german: 2,
          romance: 2,
          slavicLatin: 2,
          cyrillic: 2,
          greek: 2,
          emoji: 2,
        },
      },
    });
    const probes = createProbes();
    const result = await tune({
      probes,
      countTokens: (input) => target.count(input),
    });
    const fitted = createUsageEstimator(result.profile);
    for (const contrast of probes.textRules!) {
      expect(
        fitted.count(contrast.after) - fitted.count(contrast.before),
        contrast.field,
      ).toBe(target.count(contrast.after) - target.count(contrast.before));
    }
    for (const field of result.report.text.rules) {
      expect(field.afterRmse, field.field).toBeCloseTo(0, 8);
      // Scales of unaccented words have no probes; running text fits them.
      expect(field.identifiable, field.field).toBe(
        !field.field.startsWith("text.unaccentedWordScale."),
      );
    }
    expect(
      result.report.text.rules.find(
        (field) => field.field === "text.digitsPerToken",
      )!.final,
    ).not.toBe(3);
    expect(result.report.text.multiplier).toBeCloseTo(2, 10);
  });

  it("measures the shared short-segment gate with punctuation instead of inferring it from words alone", async () => {
    const target = createUsageEstimator({
      contentMultiplier: 2,
      text: { shortTokenThreshold: 0, punctuationCharsPerToken: 2.5 },
    });
    const result = await tune({
      countTokens: (input) => target.count(input),
    });
    const threshold = result.report.text.rules.find(
      (field) => field.field === "text.shortTokenThreshold",
    )!;
    expect(threshold.coupledWith).toEqual(["punctuationCharsPerToken"]);
    expect(
      result.report.text.rules.find(
        (field) => field.field === "text.punctuationCharsPerToken",
      )!.afterRmse,
    ).toBeCloseTo(0, 8);
    const independent: UsageInput = {
      messages: [{ role: "user", content: "!!! ????????" }],
    };
    expect(createUsageEstimator(result.profile).count(independent)).toBe(
      target.count(independent),
    );
  });

  it("rejects a text contrast mislabeled as measuring an unrelated rule", async () => {
    const probes = createProbes();
    probes.textRules = [
      {
        field: "digitsPerToken",
        before: { messages: [{ role: "user", content: "a" }] },
        after: {
          messages: [
            { role: "user", content: "123456 UnrelatedLongWordContent" },
          ],
        },
      },
    ];
    const target = createUsageEstimator({ contentMultiplier: 2 });
    await expect(
      tune({
        probes,
        countTokens: (input) => target.count(input),
      }),
    ).rejects.toThrow(TypeError);
  });

  it("retains text parameters without contrasts and reports them as absent", async () => {
    const probes = createProbes();
    probes.textRules = [];
    const target = createUsageEstimator({ contentMultiplier: 2 });
    const initial = { text: { digitsPerToken: 4, kanaCharsPerToken: 2 } };
    const result = await tune({
      initial,
      probes,
      countTokens: (input) => target.count(input),
    });
    expect(result.profile.text).toEqual(textRules(initial.text));
    expect(
      result.report.text.rules.every(
        (field) => !field.identifiable && field.reason === "absent",
      ),
    ).toBe(true);
  });

  it("reports residual overhead errors when requests with the same features have different costs", async () => {
    const probes = createProbes();
    const source = probes.overhead.find(
      (probe) => probe.after.tools && !probe.before.tools,
    )!;
    const booleanProperty: UsageInput = {
      ...source.after,
      tools: {
        a: {
          ...source.after.tools!.a!,
          inputSchema: jsonSchema({
            type: "object",
            properties: { q: { type: "boolean" } },
          }),
        },
      },
    };
    probes.overhead = [
      ...probes.overhead,
      { before: source.after, after: booleanProperty },
    ];
    const target = createUsageEstimator({ contentMultiplier: 2 });
    const result = await tune({
      probes,
      countTokens: (input) =>
        target.count(input) + (input === booleanProperty ? 8 : 0),
    });
    expect(result.report.overhead.contrasts.maxError).toBeGreaterThan(1);
    expect(result.report.overhead.contrasts.rmse).toBeGreaterThan(0);
    expect(result.report.overhead.contrasts.exactFraction).toBeLessThan(1);
  });

  it("flags inseparable tool-call/result costs and retains the initial value of the dependent field", async () => {
    const probes = createProbes();
    const completedOnly = {
      ...probes,
      overhead: probes.overhead.filter(
        (probe) => probe.after.messages.at(-1)?.role !== "assistant",
      ),
    };
    const target = createUsageEstimator({
      contentMultiplier: 2,
      perToolCall: 50,
      perToolResult: 25,
    });
    const result = await tune({
      probes: completedOnly,
      initial: { perToolResult: 12 },
      countTokens: (input) => target.count(input),
    });
    expect(
      result.report.fields.find((field) => field.field === "perToolResult"),
    ).toMatchObject({ identifiable: false, reason: "collinear" });
    expect(result.profile.perToolResult).toBe(12);
    expect(
      result.profile.perToolCall + result.profile.perToolResult,
    ).toBeCloseTo(75, 10);
    expect(result.report.overhead.after.loss).toBe(0);
  });

  it("counts repeated controls once per run and completes text calibration before counting overhead", async () => {
    const probes = createProbes({
      texts: ["Books and records are stored in the library."],
    });
    probes.text = [...probes.text, probes.text[0]!, probes.overhead[0]!.before];
    probes.overhead = [...probes.overhead, probes.overhead[0]!];
    const target = createUsageEstimator({ contentMultiplier: 2 });
    const counted: UsageInput[] = [];
    const progress: TuneProgress[] = [];
    const options = {
      probes,
      countTokens: async (input: UsageInput) => {
        counted.push(input);
        return target.count(input);
      },
      onProgress: (event: TuneProgress) => progress.push(event),
    };
    const first = await tune(options);
    const calls = counted.length;
    const second = await tune(options);
    expect(first.report.counterCalls).toBe(calls);
    expect(second.report.counterCalls).toBe(calls);
    expect(counted).toHaveLength(calls * 2);
    expect(
      new Set(counted.slice(0, calls).map((input) => JSON.stringify(input)))
        .size,
    ).toBe(calls);
    const textFit = progress.findIndex(
      (event) => event.stage === "text" && event.phase === "fit",
    );
    const overheadCollect = progress.findIndex(
      (event) => event.stage === "overhead" && event.phase === "collect",
    );
    expect(textFit).toBeLessThan(overheadCollect);
    expect(second.profile).toEqual(first.profile);
  });

  it("reports independent validation errors without using them to alter either phase", async () => {
    const validation: UsageInput = {
      messages: [
        {
          role: "user",
          content: "An independent evaluation request with unexpected costs.",
        },
      ],
    };
    const target = createUsageEstimator({ contentMultiplier: 2 });
    const result = await tune({
      validationSamples: [validation],
      countTokens: (input) =>
        target.count(input) + (input === validation ? 500 : 0),
    });
    expect(result.profile.contentMultiplier).toBeCloseTo(2, 10);
    for (const field of STRUCTURAL_FIELDS)
      expect(result.profile[field], field).toBeCloseTo(
        target.profile[field],
        10,
      );
    expect(result.report.validation!.after.count).toBe(1);
    expect(result.report.validation!.after.mape).toBeGreaterThan(0);
  });

  it("rejects text probes whose equal estimates cannot identify a slope and intercept", async () => {
    const probes = createProbes();
    await expect(
      tune({
        probes: {
          ...probes,
          text: ["a", "b"].map((content) => ({
            messages: [{ role: "user", content }],
          })),
        },
        countTokens: () => 10,
      }),
    ).rejects.toThrow(RangeError);
  });

  it("honors cancellation between the text and overhead phases", async () => {
    const probes = createProbes({
      texts: ["Books and records are stored in the library."],
    });
    const controller = new AbortController();
    const target = createUsageEstimator({ contentMultiplier: 2 });
    const counted: UsageInput[] = [];
    await expect(
      tune({
        probes,
        signal: controller.signal,
        countTokens: (input) => {
          counted.push(input);
          return target.count(input);
        },
        onProgress: (event) => {
          if (event.stage === "text" && event.phase === "fit")
            controller.abort(new Error("Stop after text"));
        },
      }),
    ).rejects.toThrow("Stop after text");
    const countedKeys = new Set(counted.map((input) => JSON.stringify(input)));
    for (const input of [
      ...probes.text,
      ...(probes.textRules ?? []).flatMap((probe) => [
        probe.before,
        probe.after,
      ]),
    ])
      expect(countedKeys.has(JSON.stringify(input))).toBe(true);
    expect(
      counted.every(
        (input) =>
          input.messages.length === 1 &&
          input.messages[0]!.role === "user" &&
          !input.tools,
      ),
    ).toBe(true);
  });

  it("retains absent structural weights and explicitly reports them", async () => {
    const probes = createProbes();
    const before: UsageInput = { messages: [{ role: "user", content: "a" }] };
    const after: UsageInput = {
      messages: [
        { role: "user", content: "a" },
        { role: "assistant", content: "a" },
        { role: "user", content: "a" },
      ],
    };
    const initial = resolveProfile({ perFile: 712, perImage: 219 });
    const result = await tune({
      initial,
      probes: { ...probes, overhead: [{ before, after }] },
      countTokens: (input) =>
        createUsageEstimator({ contentMultiplier: 2 }).count(input),
    });
    expect(
      result.report.fields.find((field) => field.field === "perFile"),
    ).toMatchObject({ identifiable: false, reason: "absent" });
    expect(result.profile.perFile).toBe(712);
    expect(result.profile.perImage).toBe(219);
    expect(result.report.overhead.rank).toBe(2);
  });
});

describe("counting", () => {
  const plainText = (input: UsageInput): string | undefined =>
    input.messages.length === 1 && !input.tools
      ? (input.messages[0]!.content as string)
      : undefined;

  it("counts each plain text once per run, and counts again on the next run", async () => {
    const target = createUsageEstimator();
    const runs: UsageInput[][] = [[], []];
    for (const log of runs)
      await tune({
        countTokens: (input) => {
          log.push(input);
          return target.count(input);
        },
      });
    const texts = runs[0]!.flatMap((input) => plainText(input) ?? []);
    expect(new Set(texts).size).toBe(texts.length);
    expect(runs[1]).toHaveLength(runs[0]!.length);
  });

  it("limits concurrent counter calls", async () => {
    const target = createUsageEstimator();
    let running = 0;
    let maximum = 0;
    await tune({
      concurrency: 2,
      countTokens: async (input) => {
        maximum = Math.max(maximum, ++running);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        running--;
        return target.count(input);
      },
    });
    expect(maximum).toBe(2);
  });

  it("aborts before counting and while a counter call is pending", async () => {
    const stopped = new AbortController();
    stopped.abort(new Error("Stopped"));
    let calls = 0;
    await expect(
      tune({ signal: stopped.signal, countTokens: () => ++calls }),
    ).rejects.toThrow("Stopped");
    expect(calls).toBe(0);
    const controller = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pending = tune({
      signal: controller.signal,
      countTokens: () => {
        started();
        return new Promise<number>(() => {});
      },
    });
    await ready;
    controller.abort(new Error("Stopped"));
    await expect(pending).rejects.toThrow("Stopped");
  });

  it("stops counting after a counter failure", async () => {
    let calls = 0;
    await expect(
      tune({
        concurrency: 1,
        countTokens: () => {
          calls++;
          throw new Error("Counter failed");
        },
      }),
    ).rejects.toThrow("Counter failed");
    expect(calls).toBe(1);
  });

  it.each([NaN, Infinity, -1])(
    "rejects an invalid count (%s)",
    async (value) => {
      await expect(tune({ countTokens: () => value })).rejects.toThrow(
        TypeError,
      );
    },
  );
});
