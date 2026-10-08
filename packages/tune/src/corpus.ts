import type { UsageInput } from "@tokenxl/count/internal";
import type { ToolSet } from "ai";
import { DOCUMENTS } from "./corpus/documents.ts";
import { LANGUAGE_DOCUMENTS } from "./corpus/languages.ts";
import { TEXT_SELECTION_DOCUMENTS } from "./corpus/selection.ts";
import type { Probes } from "./probes.ts";
import { createProbes } from "./probes.ts";

export interface TuningCorpus {
  probes: Probes;
  textSamples: readonly UsageInput[];
  textSelectionSamples: readonly UsageInput[];
  validationSamples: readonly UsageInput[];
}

// Plain JSON Schema keeps the corpus free of runtime dependencies.
const SEARCH_TOOLS = {
  search_catalog: {
    description:
      "Search the catalog for matching records and return their titles and identifiers.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words or phrases to find." },
        limit: { type: "integer", description: "Maximum number of records." },
        mode: { type: "string", enum: ["brief", "detailed"] },
        filter: {
          type: "object",
          properties: { collection: { type: "string" } },
        },
      },
      required: ["query"],
    },
  },
} as unknown as ToolSet;

/** The same text as a plain request, with a system prompt and tools, and in a tool exchange. */
function createRequestVariants(text: string): UsageInput[] {
  return [
    { messages: [{ role: "user", content: text }] },
    {
      messages: [
        {
          role: "system",
          content: "Summarize the supplied material accurately.",
        },
        { role: "user", content: text },
      ],
      tools: SEARCH_TOOLS,
    },
    {
      messages: [
        { role: "user", content: text },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "toolu_catalog_001",
              toolName: "search_catalog",
              input: { query: "library", limit: 3, mode: "brief" },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "toolu_catalog_001",
              toolName: "search_catalog",
              output: {
                type: "json",
                value: { records: [{ id: 17, title: "Library catalog" }] },
              },
            },
          ],
        },
        {
          role: "user",
          content: "Use these results to answer the original question.",
        },
      ],
      tools: SEARCH_TOOLS,
    },
  ];
}

const createRequest = (content: string): UsageInput => ({
  messages: [{ role: "user", content }],
});
const sliceCodePoints = (text: string, start: number, length: number): string =>
  [...text].slice(start, start + length).join("");

function buildCorpus(): TuningCorpus {
  // Nonoverlapping excerpts of each document: the first 4,096 code points
  // calibrate, the next 2,048 select among the text refinement rounds, and the
  // last 2,048 validate, so validation requests never enter the tuner.
  const excerpts = (starts: number[]): string[] =>
    DOCUMENTS.flatMap(({ text }) =>
      starts
        .map((start) => sliceCodePoints(text, start, 2_048))
        .filter(Boolean),
    );
  const calibrationTexts = excerpts([0, 2_048]);
  return {
    probes: createProbes({
      texts: calibrationTexts,
      lengths: [128, 512, 2048],
    }),
    textSamples: [
      ...calibrationTexts,
      ...LANGUAGE_DOCUMENTS.map((document) => document.text),
    ].flatMap((text) =>
      [...new Set([text, sliceCodePoints(text, 0, 512)])].map(createRequest),
    ),
    // Authored documents alone are simpler than natural text, so natural
    // excerpts also take part in the selection.
    textSelectionSamples: [
      ...TEXT_SELECTION_DOCUMENTS.flatMap((document) => [
        document.text,
        sliceCodePoints(document.text, 0, 256),
      ]),
      ...excerpts([4_096]),
    ]
      .filter((text, index, texts) => texts.indexOf(text) === index)
      .map(createRequest),
    validationSamples: excerpts([6_144]).flatMap(createRequestVariants),
  };
}

/**
 * The built-in tuning inputs: controlled probes, natural text, separate
 * selection documents, and validation requests. Pass it with a provider
 * adapter: `tuneProfile({ ...adapter, ...tuningCorpus })`.
 */
export const tuningCorpus: Readonly<TuningCorpus> = Object.freeze(
  buildCorpus(),
);
