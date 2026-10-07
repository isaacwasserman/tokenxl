import type { JSONSchema7, ModelMessage } from "ai";
import { resolveTokenEstimationOptions, walkSegments } from "../segments.ts";
import type { UsageInput } from "../usage/types.ts";
import {
  createTools,
  PROBE_FILE,
  PROBE_IMAGE,
  TEXTS,
} from "./probe-fixtures.ts";
import type { TextField } from "./text.ts";
import { ALL_TEXT_FIELDS, buildHistogram } from "./text.ts";

/** A controlled change. Directly measured text costs are subtracted from its token delta. */
export interface OverheadProbe {
  before: UsageInput;
  after: UsageInput;
}

/** Only the named text rule and known unit-word controls may change. */
export interface TextRuleProbe extends OverheadProbe {
  field: TextField;
}

export interface Probes {
  /** Scale anchors: one user text message per request; no tools or other parts. */
  text: readonly UsageInput[];
  /** Controlled text contrasts, grouped by the rule they measure. */
  textRules?: readonly TextRuleProbe[];
  /** Context contrasts diagnosed separately; they do not fit a rule. */
  textContext?: readonly OverheadProbe[];
  overhead: readonly OverheadProbe[];
}

export interface ProbeOptions {
  /** Representative text from which rule-specific segments are selected. */
  texts?: readonly string[];
  /** Approximate payload lengths in code points; defaults to 64, 256, and 1024. */
  lengths?: readonly number[];
}

/**
 * An accent rule prices a whole language through the minority of its words
 * that carry an accent, so its ratio also covers the unaccented words. Isolated
 * accented words would measure something else; these ratios are fitted on
 * running text only.
 */
export const RUNNING_TEXT_FIELDS: ReadonlySet<TextField> = new Set([
  "german",
  "romance",
  "slavicLatin",
]);

/** Controlled contrasts rather than random combinations of request features. */
export function createProbes(options: ProbeOptions = {}): Probes {
  const texts = options.texts ?? TEXTS.slice(0, 13);
  const lengths = options.lengths ?? [64, 256, 1024];
  if (
    !texts.length ||
    texts.some((text) => typeof text !== "string" || !text.trim())
  )
    throw new TypeError("tokenx: Probe texts must contain nonempty text.");
  if (
    lengths.length < 2 ||
    lengths.some((length) => !Number.isInteger(length) || length < 1)
  )
    throw new RangeError(
      "tokenx: Provide at least two positive integer text lengths.",
    );
  if (new Set(lengths).size < 2)
    throw new RangeError("tokenx: Text lengths must vary.");
  const createRequest = (content: string): UsageInput => ({
    messages: [{ role: "user", content }],
  });
  // One-character ASCII words cost one estimated token independently of
  // word-length gates and all character ratios in their meaningful range.
  const text = ["a", "I", "x", "z"].flatMap((word) =>
    lengths.map((length) =>
      createRequest(
        Array.from({ length: Math.max(1, Math.ceil(length / 2)) })
          .fill(word)
          .join(" "),
      ),
    ),
  );
  const textRules = createTextRuleProbes(texts, lengths, createRequest);
  const contextWords = [
    ...new Set(texts.join(" ").match(/[a-z]{3,16}/gi) ?? []),
  ].slice(0, 8);
  const textContext = (
    contextWords.length ? contextWords : ["library", "Weather", "catalog"]
  ).flatMap((word) => [
    { before: createRequest(word), after: createRequest(`a ${word}`) },
    { before: createRequest(`a ${word}`), after: createRequest(`a\n${word}`) },
    {
      before: createRequest(`a\n${word}`),
      after: createRequest(`a\n  ${word}`),
    },
    { before: createRequest(`a ${word}`), after: createRequest(`a: ${word}`) },
    { before: createRequest(word), after: createRequest(`"${word}"`) },
  ]);
  const overhead: OverheadProbe[] = [];
  const empty: JSONSchema7 = {
    type: "object",
    properties: {},
    additionalProperties: false,
  };

  // Repeated controls average out rounding and name/content token boundaries.
  for (const content of ["a", "books", "records"]) {
    const control = createRequest(content);
    const add = (before: UsageInput, after: UsageInput): void => {
      overhead.push({ before, after });
    };
    const exchange: UsageInput = {
      messages: [
        { role: "user", content },
        { role: "assistant", content },
        { role: "user", content },
      ],
    };
    add(control, exchange);
    // The message increment is measured above; its cost can be removed from
    // this contrast without introducing consecutive user turns.
    add(exchange, {
      messages: [{ role: "system", content }, ...exchange.messages],
    });
    const oneTool: UsageInput = { ...control, tools: createTools([empty]) };
    add(control, oneTool);
    const twoTools: UsageInput = {
      ...control,
      tools: createTools([empty, empty]),
    };
    add(oneTool, twoTools);
    add(twoTools, { ...control, tools: createTools([empty, empty, empty]) });
    add(oneTool, { ...control, tools: createTools([empty], true) });
    const withProperties = (
      properties: NonNullable<JSONSchema7["properties"]>,
    ): UsageInput => ({
      ...control,
      tools: createTools([{ ...empty, properties }]),
    });
    const first = withProperties({ q: { type: "string" } });
    add(oneTool, first);
    const second = withProperties({
      q: { type: "string" },
      limit: { type: "number" },
    });
    add(first, second);
    add(first, withProperties({ q: { type: "string", description: content } }));
    const twoEnum = withProperties({
      q: { type: "string", enum: ["brief", "detailed"] },
    });
    add(first, twoEnum);
    add(first, withProperties({ q: empty }));
    add(first, withProperties({ q: { type: "array", items: empty } }));
    // Each new schema term has a contrast that keeps existing features fixed.
    add(oneTool, {
      ...control,
      tools: createTools([{ type: "object", properties: {} }]),
    });
    add(oneTool, {
      ...control,
      tools: createTools([{ ...empty, additionalProperties: true }]),
    });
    add(first, withProperties({ q: { type: "integer" } }));
    add(first, withProperties({ q: { type: "boolean" } }));
    add(
      first,
      withProperties({ q: { type: "array", items: { type: "string" } } }),
    );
    add(first, withProperties({ q: { type: "string", enum: ["brief"] } }));
    add(
      twoEnum,
      withProperties({
        q: {
          type: "string",
          enum: ["brief", "detailed", "automatic", "custom"],
        },
      }),
    );
    const twoProperties: JSONSchema7 = {
      ...empty,
      properties: { q: { type: "string" }, limit: { type: "number" } },
    };
    const withRequired = (required: string[]): UsageInput => ({
      ...control,
      tools: createTools([{ ...twoProperties, required }]),
    });
    const requiredOne = withRequired(["q"]);
    add(second, withRequired([]));
    add(second, requiredOne);
    add(requiredOne, withRequired(["q", "limit"]));
    for (const part of [
      { type: "image" as const, image: PROBE_IMAGE },
      { type: "file" as const, data: PROBE_FILE, mediaType: "application/pdf" },
    ]) {
      add(control, {
        messages: [
          { role: "user", content: [{ type: "text", text: content }, part] },
        ],
      });
    }
    const call: ModelMessage = {
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: "call_1", toolName: "a", input: {} },
      ],
    };
    const called: UsageInput = {
      ...oneTool,
      messages: [...control.messages, call],
    };
    const completed: UsageInput = {
      ...oneTool,
      messages: [
        ...called.messages,
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call_1",
              toolName: "a",
              output: { type: "text", value: content },
            },
          ],
        },
      ],
    };
    // Counters that reject assistant prefills can drop the unfinished pair.
    add(oneTool, called);
    add(oneTool, completed);
    add(exchange, {
      messages: [
        control.messages[0]!,
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: content },
            { type: "text", text: content },
          ],
        },
        control.messages[0]!,
      ],
    });
  }
  return { text, textRules, textContext, overhead };
}

function createTextRuleProbes(
  texts: readonly string[],
  lengths: readonly number[],
  createRequest: (text: string) => UsageInput,
): TextRuleProbe[] {
  const buckets = new Map<TextField, Set<string>>(
    ALL_TEXT_FIELDS.map((field) => [field, new Set()]),
  );
  const add = (field: TextField, segment: string): void => {
    if (buckets.get(field)!.size < 120) buckets.get(field)!.add(segment);
  };
  const scan = (value: string): void => {
    for (const { segment } of walkSegments(
      value,
      resolveTokenEstimationOptions(),
    )) {
      const histogram = buildHistogram(segment);
      if (histogram.rules.size !== 1) continue;
      const rule = histogram.rules.values().next().value!.rule;
      switch (rule.kind) {
        case "word":
          if (!/^[a-z]+$/i.test(segment)) break;
          if (segment.length > 16)
            add(
              "defaultCharsPerToken",
              segment[0]!.toUpperCase() + segment.slice(1),
            );
          if (segment.length <= 16)
            add(
              "shortTokenThreshold",
              segment[0]!.toUpperCase() + segment.slice(1),
            );
          if (segment.length <= 24)
            add("lowercaseWordMaxLength", segment.toLowerCase());
          break;
        case "digits":
          add("digitsPerToken", segment);
          break;
        case "punctuation":
          add("punctuationCharsPerToken", segment);
          break;
        case "language":
          add(rule.language, segment);
          break;
        case "cjk": {
          const present = [rule.hanzi, rule.kana, rule.hangul].filter(
            (count) => count > 0,
          ).length;
          if (present === 1)
            add(
              rule.hanzi
                ? "hanziCharsPerToken"
                : rule.kana
                  ? "kanaCharsPerToken"
                  : "hangulCharsPerToken",
              segment,
            );
          break;
        }
      }
    }
    // Split mixed Japanese runs into the same pure-script pieces that the
    // combined CJK formula prices, without mixing the two unknown ratios.
    for (const segment of value.match(/\p{Script=Han}+/gu) ?? [])
      add("hanziCharsPerToken", segment);
    for (const segment of value.match(/[\u3040-\u30FF]+/g) ?? [])
      add("kanaCharsPerToken", segment);
  };
  for (const value of texts) scan(value);
  // Fill missing buckets without replacing segments from representative text.
  const missing = new Set(
    ALL_TEXT_FIELDS.filter((field) => !buckets.get(field)!.size),
  );
  const fallback = [
    ...TEXTS,
    "RequestSerializationOptions ResolvedTokenEstimationOptions Internationalization Misinterpretations Compartmentalization Straightforwardness",
  ];
  const original = new Map(
    [...buckets].map(([field, values]) => [field, new Set(values)]),
  );
  for (const value of fallback) scan(value);
  for (const field of ALL_TEXT_FIELDS) {
    if (!missing.has(field)) buckets.set(field, original.get(field)!);
  }
  const probes: TextRuleProbe[] = [];
  for (const field of ALL_TEXT_FIELDS) {
    const words = [...buckets.get(field)!];
    if (!words.length || RUNNING_TEXT_FIELDS.has(field)) continue;
    // Different lexical sets, not merely longer repetitions of one mixture.
    const groups = Array.from({ length: Math.min(3, words.length) }, (_, n) =>
      words.filter((_, k) => k % Math.min(3, words.length) === n),
    );
    for (const [groupIndex, group] of groups.entries()) {
      const length = lengths[groupIndex % lengths.length]!;
      // Preserve complete segments; a truncated long word would reintroduce
      // the short-word rule into a probe intended for the general ratio.
      const parts: string[] = [];
      let size = 0;
      while (size < length) {
        const word = group[parts.length % group.length]!;
        parts.push(word);
        size += [...word].length + 1;
      }
      probes.push({
        field,
        before: createRequest("a"),
        after: createRequest(parts.join(" ")),
      });
      // The shortest and longest payloads check scaling on this lexical set.
      if (length !== lengths[0]) {
        const short = parts.slice(
          0,
          Math.max(1, Math.ceil((parts.length * lengths[0]!) / length)),
        );
        probes.push({
          field,
          before: createRequest("a"),
          after: createRequest(short.join(" ")),
        });
      }
    }
  }
  // A mixture of natural punctuation lengths can hide the gate: two ratios
  // may fit its aggregate count while disagreeing on a three-character run.
  // Sweep lengths across the gate's supported range, plus longer controls,
  // so the shared gate and punctuation ratio have distinct measurements.
  for (const length of [
    ...Array.from({ length: 16 }, (_, n) => n + 2),
    24,
    32,
  ]) {
    const punctuation = Array.from({ length }, (_, n) => "!?:;=<>()"[n % 9]!);
    const segment = punctuation.join("");
    const repeats = Math.max(1, Math.ceil(lengths[0]! / (length + 1)));
    probes.push({
      field: "punctuationCharsPerToken",
      before: createRequest("a"),
      after: createRequest(
        Array.from({ length: repeats }).fill(segment).join(" "),
      ),
    });
  }
  return probes;
}
