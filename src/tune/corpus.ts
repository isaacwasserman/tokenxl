import type { ToolSet } from "ai";
import type { UsageInput } from "../usage/types.ts";
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
export function createRequestVariants(text: string): UsageInput[] {
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
  // Nonoverlapping excerpts of each document: the first 4,096 code points calibrate,
  // the next 4,096 validate, so validation requests never enter the tuner.
  const calibrationTexts = DOCUMENTS.flatMap(({ text }) =>
    [0, 2_048]
      .map((start) => sliceCodePoints(text, start, 2_048))
      .filter(Boolean),
  );
  const validationTexts = DOCUMENTS.flatMap(({ text }) =>
    [4_096, 6_144]
      .map((start) => sliceCodePoints(text, start, 2_048))
      .filter(Boolean),
  );
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
    textSelectionSamples: TEXT_SELECTION_DOCUMENTS.flatMap((document) =>
      [...new Set([document.text, sliceCodePoints(document.text, 0, 256)])].map(
        createRequest,
      ),
    ),
    validationSamples: validationTexts.flatMap(createRequestVariants),
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
