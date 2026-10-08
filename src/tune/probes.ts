import type { JSONSchema7, ModelMessage, ToolSet } from "ai";
import { resolveTokenEstimationOptions, walkSegments } from "../segments.ts";
import type { UsageInput } from "../usage/types.ts";
import type { TextField } from "./text.ts";
import { ALL_TEXT_FIELDS, buildHistogram } from "./text.ts";

/**
 * A valid black-and-white PNG of the given size as a data URL. Stored deflate
 * blocks need no compression library; providers price images by size only.
 */
export function createProbeImage(width: number, height: number): string {
  const row = 1 + Math.ceil(width / 8);
  const raw = new Uint8Array(row * height);
  // Alternate rows of black and white, after each row's filter byte.
  for (let y = 0; y < height; y++)
    if (y % 2) raw.fill(0xff, y * row + 1, (y + 1) * row);
  const blocks = Math.max(1, Math.ceil(raw.length / 65_535));
  const deflate = new Uint8Array(2 + raw.length + 5 * blocks + 4);
  deflate.set([0x78, 0x01]);
  let offset = 2;
  for (let block = 0; block < blocks; block++) {
    const part = raw.subarray(block * 65_535, (block + 1) * 65_535);
    deflate.set(
      [
        block === blocks - 1 ? 1 : 0,
        part.length & 0xff,
        part.length >> 8,
        ~part.length & 0xff,
        (~part.length >> 8) & 0xff,
      ],
      offset,
    );
    deflate.set(part, offset + 5);
    offset += 5 + part.length;
  }
  let a = 1;
  let b = 0;
  for (const byte of raw) {
    a = (a + byte) % 65_521;
    b = (b + a) % 65_521;
  }
  setUint32(deflate, offset, ((b << 16) | a) >>> 0);
  const header = new Uint8Array(13);
  setUint32(header, 0, width);
  setUint32(header, 4, height);
  header.set([1, 0, 0, 0, 0], 8);
  const bytes = concat([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflate),
    chunk("IEND", new Uint8Array()),
  ]);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return `data:image/png;base64,${btoa(binary)}`;
}

function setUint32(target: Uint8Array, offset: number, value: number): void {
  target.set(
    [value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff],
    offset,
  );
}

function concat(parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    parts.reduce((sum, part) => sum + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function chunk(type: string, data: Uint8Array): Uint8Array {
  const result = new Uint8Array(12 + data.length);
  setUint32(result, 0, data.length);
  for (let index = 0; index < 4; index++)
    result[4 + index] = type.charCodeAt(index);
  result.set(data, 8);
  let crc = 0xffffffff;
  for (const byte of result.subarray(4, 8 + data.length))
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  setUint32(result, 8 + data.length, (crc ^ 0xffffffff) >>> 0);
  return result;
}

// Image sizes for the patch probes: several aspect ratios, edges that are not
// multiples of common patch sizes, and below the resize limits of the
// measured providers, so the probes measure patches without resizing.
const PROBE_IMAGE_SIZES: readonly [number, number][] = [
  [64, 64],
  [200, 120],
  [120, 200],
  [333, 250],
  [500, 90],
  [700, 520],
  [1000, 740],
];

// Valid, small media fixtures so a ground-truth counter can inspect their data.
const PROBE_IMAGE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC";
const PROBE_FILE =
  "JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAxMDAgMTAwXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA0IDAgUiA+PiA+PiAvQ29udGVudHMgNSAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iago1IDAgb2JqCjw8IC9MZW5ndGggNTUgPj4Kc3RyZWFtCkJUIC9GMSAxMiBUZiAyMCAyMCBUZCAodG9rZW54IGNhbGlicmF0aW9uIHByb2JlKSBUaiBFVAplbmRzdHJlYW0KZW5kb2JqCnhyZWYKMCA2CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAwOSAwMDAwMCBuIAowMDAwMDAwMDU4IDAwMDAwIG4gCjAwMDAwMDAxMTUgMDAwMDAgbiAKMDAwMDAwMDI0MSAwMDAwMCBuIAowMDAwMDAwMzExIDAwMDAwIG4gCnRyYWlsZXIKPDwgL1NpemUgNiAvUm9vdCAxIDAgUiA+PgpzdGFydHhyZWYKNDE1CiUlRU9GCg==";

const TEXTS: readonly string[] = [
  "The harbor library opens before sunrise. Readers exchange notes about maps, weather, and the boats returning from the islands. A careful estimate helps keep their shared conversation within its budget.",
  "const result = records.filter(record => record.enabled).map(record => ({ id: record.id, label: record.name }));\nif (result.length > 0) {\n  console.log(JSON.stringify(result));\n}\n",
  '{"version":12,"items":[{"id":"alpha","active":true,"score":0.875},{"id":"beta","active":false,"score":0.125}],"metadata":{"region":"north","attempts":1234567890}}',
  "# Field notes\n\n- Check the weather forecast.\n- Compare the two routes.\n\n| Route | Distance |\n| --- | --- |\n| Harbor | 12 |\n| Forest | 34 |\n\nUse **clear descriptions** and `stable identifiers`.",
  "人工智能技术帮助研究人员整理图书资料。天气晴朗的时候，我们沿着河流走到城市中心，讨论数据分析和语言模型。",
  "こんにちは。図書館で新しい資料を調べています。旅行の予定について話し合い、天気と交通の情報を確認してください。",
  "안녕하세요. 도서관에서 새로운 자료를 찾고 있습니다. 여행 계획을 세우면서 날씨와 교통 정보를 확인하고 기록합니다.",
  "Die Größenordnung verändert sich täglich. Überprüfen Sie die ausführliche Beschreibung der öffentlichen Bücher und berücksichtigen Sie ungewöhnliche Möglichkeiten.",
  "Une étude détaillée décrit les échanges à proximité du musée. El diseño de la colección reúne información útil sobre música, árboles y ciudades.",
  "Zażółć gęślą jaźń. Příliš žluťoučký kůň úpěl ďábelské ódy. Właściwości narzędzia opisują różne możliwości wyszukiwania.",
  "Библиотека открывается утром. Исследователи обсуждают результаты измерений, проверяют документы и составляют подробный план путешествия.",
  "Η βιβλιοθήκη ανοίγει το πρωί. Οι ερευνητές εξετάζουν νέες πληροφορίες και καταγράφουν τα αποτελέσματα της συζήτησης.",
  "😀😃😄😁😆😅😂🤣 😊🙂🙃😉😍🥰 😎🤔🧐🤓 👍🏽👍🏾👋🏽 🌳🌲🌴🌵",
  "123456789012345678901234567890 999999999999999 12345 678901234567 3141592653589793238462643383279",
  "------- :::::::::: {{{{{{{{ ((((((((((((( ......... !?!?!?!?!?!?!? ______________ /////////",
  "A Ab Abc Abcd Abcde Abcdef Abcdefgh Abcdefghijk Abcdefghijklmn abc abcd abcdef abcdefgh abcdefghijk abcdefghijklmnop",
];

/** An SDK Schema wrapper without importing the SDK at runtime. */
function createTools(
  schemas: JSONSchema7[],
  descriptions: boolean = false,
): ToolSet {
  return Object.fromEntries(
    schemas.map((jsonSchema, index) => [
      String.fromCharCode(97 + index),
      {
        description: descriptions
          ? `Find records in collection ${index}.`
          : undefined,
        inputSchema: {
          [Symbol.for("vercel.ai.schema")]: true,
          _type: undefined,
          jsonSchema,
          validate: undefined,
        },
      },
    ]),
  ) as ToolSet;
}

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

interface ProbeOptions {
  /** Representative text from which rule-specific segments are selected. */
  texts?: readonly string[];
  /** Approximate payload lengths in code points; defaults to 64, 256, and 1024. */
  lengths?: readonly number[];
}

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
    // Nested objects have properties in real schemas; some providers render
    // the first nested property more cheaply than a first root property.
    const inner: JSONSchema7 = {
      ...empty,
      properties: { q: { type: "string" } },
    };
    add(first, withProperties({ q: inner }));
    add(first, withProperties({ q: { type: "array", items: inner } }));
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
    add(first, withProperties({ q: { type: ["string", "null"] } }));
    add(
      first,
      withProperties({
        q: { anyOf: [{ type: "string" }, { type: "number" }] },
      }),
    );
    // Annotation keywords: the first of a node, then a further one.
    const formatted = withProperties({
      q: { type: "string", format: "date" },
    });
    add(first, formatted);
    add(
      formatted,
      withProperties({ q: { type: "string", format: "date", maxLength: 10 } }),
    );
    add(
      second,
      withProperties({
        q: { type: "string" },
        limit: { type: "number", minimum: 1, maximum: 50 },
      }),
    );
    // A schema-valued keyword renders like `true`, beside properties.
    add(first, {
      ...control,
      tools: createTools([
        {
          type: "object",
          properties: { q: { type: "string" } },
          additionalProperties: { type: "string" },
        },
      ]),
    });
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
    // Patches separate from the fixed image cost only across image sizes.
    const images =
      content === "a"
        ? PROBE_IMAGE_SIZES.map(([width, height]) =>
            createProbeImage(width, height),
          )
        : [];
    for (const part of [
      { type: "file" as const, data: PROBE_IMAGE, mediaType: "image/png" },
      ...images.map((data) => ({
        type: "file" as const,
        data,
        mediaType: "image/png",
      })),
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
    // Two calls in one message can cost more than two separate exchanges.
    const result = (toolCallId: string) => ({
      type: "tool-result" as const,
      toolCallId,
      toolName: "a",
      output: { type: "text" as const, value: content },
    });
    const twoCalls = (together: boolean): UsageInput => {
      const call = (toolCallId: string) => ({
        type: "tool-call" as const,
        toolCallId,
        toolName: "a",
        input: {},
      });
      return {
        ...oneTool,
        messages: together
          ? [
              control.messages[0]!,
              { role: "assistant", content: [call("call_1"), call("call_2")] },
              { role: "tool", content: [result("call_1"), result("call_2")] },
            ]
          : [
              control.messages[0]!,
              { role: "assistant", content: [call("call_1")] },
              { role: "tool", content: [result("call_1")] },
              { role: "assistant", content: [call("call_2")] },
              { role: "tool", content: [result("call_2")] },
            ],
      };
    };
    add(twoCalls(false), twoCalls(true));
    // An image in a tool result can cost more than one in a user message.
    // Results with a text and an image are the common case.
    const withResult = (value: unknown[]): UsageInput => ({
      ...completed,
      messages: completed.messages.map((message) =>
        message.role === "tool"
          ? ({
              role: "tool",
              content: [
                {
                  type: "tool-result",
                  toolCallId: "call_1",
                  toolName: "a",
                  output: { type: "content", value },
                },
              ],
            } as ModelMessage)
          : message,
      ),
    });
    const resultText = { type: "text", text: content };
    add(
      withResult([resultText]),
      withResult([
        resultText,
        {
          type: "image-data",
          data: PROBE_IMAGE.slice(PROBE_IMAGE.indexOf(",") + 1),
          mediaType: "image/png",
        },
      ]),
    );
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
    // The scales of unaccented words get no segments: they are fitted on
    // running text only.
    if (!words.length) continue;
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
  // The same lowercase words joined by spaces and then by underscores: only
  // the underscores change.
  const lowercase = [...buckets.get("lowercaseWordMaxLength")!]
    .filter((word) => word.length <= 6)
    .slice(0, 24);
  for (const count of [4, 12, 24]) {
    const words = Array.from(
      { length: count },
      (_, n) =>
        (lowercase.length ? lowercase : ["file", "name"])[
          n % Math.max(1, lowercase.length)
        ]!,
    );
    probes.push({
      field: "innerUnderscoreTokens",
      before: createRequest(words.join(" ")),
      after: createRequest(words.join("_")),
    });
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
