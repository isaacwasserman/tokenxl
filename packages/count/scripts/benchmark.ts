// Benchmarks tokenxl: its accuracy against OpenAI's o200k_base on the sample
// corpus, and the speed of text and request counting against gpt-tokenizer and
// ai-tokenizer. Makes no API calls.
//
//   node scripts/benchmark.ts
//
// Prints a report and saves it to <system temp>/tokenxl/benchmark.md. The BPE
// tokenizers keep internal caches, so their repeated runs are warm.

import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ModelMessage, ToolSet } from "ai";
import { jsonSchema, tool } from "ai";
import { models, Tokenizer } from "ai-tokenizer";
import * as claude from "ai-tokenizer/encoding/claude";
import { count } from "ai-tokenizer/sdk";
import { encode } from "gpt-tokenizer/encoding/o200k_base";
import { z } from "zod";
import {
  createUsageEstimator,
  estimateTokenCount,
  splitByTokens,
} from "../src/index.ts";
import {
  BENCHMARK_SAMPLES,
  MAX_SAMPLE_DEVIATION,
  readSampleText,
} from "../test/fixtures/samples.ts";

// Generated output goes to the system temporary directory, never into the repository.
const reportPath = path.join(os.tmpdir(), "tokenxl", "benchmark.md");
const textsDir = path.resolve(import.meta.dirname, "../test/fixtures/texts");

const BAR_CELLS_PER_SIDE = 10;
const PERCENT_PER_BAR_CELL = MAX_SAMPLE_DEVIATION / BAR_CELLS_PER_SIDE;
const PERCENT_COLUMN_WIDTH = 8;

interface SampleMeasurement {
  description: string;
  referenceTokenCount: number;
  estimatedTokenCount: number;
  /** Positive when tokenxl overestimates, negative when it underestimates. */
  signedDeviation: number;
}

const report = [
  await benchmarkAccuracy(),
  await benchmarkTextSpeed(),
  await benchmarkRequestSpeed(),
].join("\n\n");
console.log(report);
await fsp.mkdir(path.dirname(reportPath), { recursive: true });
await fsp.writeFile(reportPath, `${report}\n`, "utf-8");
console.log(`\nWrote ${reportPath}`);

/** Compares each sample's estimate with its o200k_base count. */
async function benchmarkAccuracy(): Promise<string> {
  const measurements: SampleMeasurement[] = [];
  for (const sample of BENCHMARK_SAMPLES) {
    const text = await readSampleText(sample);
    const referenceTokenCount = encode(text).length;
    const estimatedTokenCount = estimateTokenCount(text);
    measurements.push({
      description: sample.description,
      referenceTokenCount,
      estimatedTokenCount,
      signedDeviation:
        ((estimatedTokenCount - referenceTokenCount) / referenceTokenCount) *
        100,
    });
  }
  return `## Accuracy

Bars grow left when tokenxl underestimates and right when it overestimates. The axis spans the ±${MAX_SAMPLE_DEVIATION}% per-sample deviation bound.

\`\`\`
${renderDeviationChart(measurements)}
\`\`\``;
}

/** Times the text APIs on the whole sample corpus. */
async function benchmarkTextSpeed(): Promise<string> {
  const corpus = (
    await Promise.all(BENCHMARK_SAMPLES.map(readSampleText))
  ).join("\n");
  const claudeTokenizer = new Tokenizer(claude);
  return renderTimings(
    `## Text speed

${corpus.length.toLocaleString("en-US")} UTF-16 code units.`,
    [
      ["tokenxl estimateTokenCount", () => estimateTokenCount(corpus)],
      [
        "tokenxl estimateTokenCount, cache: false",
        () => estimateTokenCount(corpus, { cache: false }),
      ],
      [
        "tokenxl splitByTokens (500-token chunks)",
        () => splitByTokens(corpus, 500),
      ],
      [
        "tokenxl splitByTokens, cache: false",
        () => splitByTokens(corpus, 500, { cache: false }),
      ],
      ["gpt-tokenizer o200k_base encode", () => encode(corpus)],
      ["ai-tokenizer claude count", () => claudeTokenizer.count(corpus)],
    ],
  );
}

/** Times request counting on a conversation of 50 messages and 10 tools. */
async function benchmarkRequestSpeed(): Promise<string> {
  const messages = await createConversation();
  const tools = createTools();
  const input = { messages, tools };
  const profile = "anthropic/claude-sonnet-5.5";
  const estimator = createUsageEstimator(profile);
  const uncached = createUsageEstimator(profile, { cache: false });
  // ai-tokenizer has no Claude Sonnet 5.5 entry; its Sonnet 4.5 entry is the closest.
  const model = models["anthropic/claude-sonnet-4.5"];
  const tokenizer = new Tokenizer(claude);
  return renderTimings(
    `## Request speed

50 messages and 10 tools, with the \`${profile}\` profile.`,
    [
      ["tokenxl count, reused estimator", () => estimator.count(input)],
      [
        "tokenxl count with breakdown",
        () => estimator.count(input, { breakdown: true }),
      ],
      ["tokenxl count, cache: false", () => uncached.count(input)],
      // A new estimator has empty caches, so it also walks every schema.
      [
        "tokenxl count, new estimator per call",
        () => createUsageEstimator(profile).count(input),
      ],
      [
        "ai-tokenizer SDK count",
        () => count({ tokenizer, model, messages, tools }),
      ],
    ],
  );
}

/** The median time of each operation over 60 runs after 20 warm-up runs. */
function renderTimings(
  heading: string,
  operations: [string, () => unknown][],
): string {
  const rows = operations.map(([name, run]) => {
    for (let n = 0; n < 20; n++) run();
    const times: number[] = [];
    for (let n = 0; n < 60; n++) {
      const start = performance.now();
      run();
      times.push(performance.now() - start);
    }
    const median = times.sort((a, b) => a - b)[30]!;
    return `${name.padEnd(42)} ${median.toFixed(3).padStart(9)} ms`;
  });
  return `${heading} Median of 60 runs after 20 warm-up runs.

\`\`\`
${rows.join("\n")}
\`\`\``;
}

function renderDeviationChart(measurements: SampleMeasurement[]): string {
  const meanDeviation =
    measurements.reduce(
      (sum, measurement) => sum + Math.abs(measurement.signedDeviation),
      0,
    ) / measurements.length;

  const labelWidth = Math.max(
    ...measurements.map((measurement) => measurement.description.length),
  );
  const countWidth = Math.max(
    ...measurements.map((measurement) =>
      Math.max(
        formatCount(measurement.referenceTokenCount).length,
        formatCount(measurement.estimatedTokenCount).length,
      ),
    ),
  );

  const rows = measurements.map((measurement) => {
    const label = measurement.description.padEnd(labelWidth);
    const counts = `${formatCount(measurement.referenceTokenCount).padStart(countWidth)} → ${formatCount(measurement.estimatedTokenCount).padStart(countWidth)}`;

    return `${label}  ${counts}   ${renderDeviationBar(measurement.signedDeviation)}  ${formatSignedPercent(measurement.signedDeviation)}`;
  });

  const barColumnOffset = labelWidth + 2 + (countWidth * 2 + 3) + 3;
  const axisHeader = `${" ".repeat(barColumnOffset)}${"under ◂".padStart(BAR_CELLS_PER_SIDE)}·▸ over`;
  const barWidth = BAR_CELLS_PER_SIDE * 2 + 1;
  const meanSeparator = `${" ".repeat(barColumnOffset)}${"─".repeat(barWidth)}`;

  const meanValue = `${meanDeviation.toFixed(2)}%`.padStart(
    2 + PERCENT_COLUMN_WIDTH,
  );
  const footerRow = `${" ".repeat(barColumnOffset + barWidth - "mean".length)}mean${meanValue}`;

  return [axisHeader, ...rows, meanSeparator, footerRow].join("\n");
}

function renderDeviationBar(signedDeviation: number): string {
  const cellCount = Math.min(
    BAR_CELLS_PER_SIDE,
    Math.round(Math.abs(signedDeviation) / PERCENT_PER_BAR_CELL),
  );
  const leftCells = signedDeviation < 0 ? cellCount : 0;
  const rightCells = signedDeviation > 0 ? cellCount : 0;

  return `${"█".repeat(leftCells).padStart(BAR_CELLS_PER_SIDE)}│${"█".repeat(rightCells).padEnd(BAR_CELLS_PER_SIDE)}`;
}

function formatSignedPercent(signedDeviation: number): string {
  const magnitude = Math.abs(signedDeviation).toFixed(2);
  const sign = Number(magnitude) === 0 ? " " : signedDeviation > 0 ? "+" : "-";

  return `${sign}${magnitude}%`.padStart(PERCENT_COLUMN_WIDTH);
}

function formatCount(count: number): string {
  return count.toLocaleString("en-US");
}

/** Ten tools with schemas of increasing size. */
function createTools(): ToolSet {
  return {
    getWeather: tool({
      description: "Get the current weather for a city.",
      inputSchema: z.object({
        city: z.string().describe("The city name"),
        unit: z.enum(["celsius", "fahrenheit"]).optional(),
      }),
    }),
    searchDocs: tool({
      description: "Search the documentation and return the best matches.",
      inputSchema: z.object({
        query: z.string().describe("The search query"),
        limit: z.number().int().min(1).max(50).optional(),
        filter: z
          .object({ section: z.string(), version: z.string().nullable() })
          .optional(),
      }),
    }),
    readFile: tool({
      description: "Read a file from the workspace.",
      inputSchema: z.object({
        path: z.string().describe("Path relative to the workspace root"),
        encoding: z.enum(["utf8", "base64"]),
      }),
    }),
    writeFile: tool({
      description: "Write a file to the workspace.",
      inputSchema: z.object({
        path: z.string(),
        content: z.string().describe("The full file content"),
        createDirectories: z.boolean().optional(),
      }),
    }),
    runCommand: tool({
      description: "Run a shell command and return its output.",
      inputSchema: z.object({
        command: z.string(),
        cwd: z.string().optional(),
        timeoutMs: z.number().optional(),
        env: z.record(z.string(), z.string()).optional(),
      }),
    }),
    createIssue: tool({
      description: "Create an issue in the tracker.",
      inputSchema: z.object({
        title: z.string(),
        body: z.string().describe("Markdown body"),
        labels: z.array(z.string()),
        priority: z.enum(["low", "medium", "high", "urgent"]),
        assignees: z.array(
          z.object({ id: z.string(), role: z.enum(["owner", "reviewer"]) }),
        ),
      }),
    }),
    queryDatabase: tool({
      description: "Run a read-only SQL query.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          sql: { type: "string", description: "The SQL statement" },
          params: { type: "array", items: { type: "string" } },
        },
        required: ["sql"],
      }),
    }),
    sendMessage: tool({
      description: "Send a chat message to a channel.",
      inputSchema: z.object({
        channel: z.string(),
        text: z.string(),
        thread: z.string().optional(),
      }),
    }),
    listReleases: tool({
      description: "List the releases of a repository.",
      inputSchema: z.object({
        owner: z.string(),
        repo: z.string(),
        page: z.number().optional(),
      }),
    }),
    planTrip: tool({
      description: "Plan a trip with several stops.",
      inputSchema: z.object({
        traveler: z.object({ name: z.string(), age: z.number().optional() }),
        stops: z.array(
          z.object({
            city: z.string().describe("Stop city"),
            nights: z.number(),
            activities: z.array(
              z.object({
                name: z.string(),
                kind: z.enum(["food", "museum", "outdoor"]),
              }),
            ),
          }),
        ),
      }),
    }),
  };
}

/** A 50-message conversation built from the fixture texts, with tool calls and results. */
async function createConversation(): Promise<ModelMessage[]> {
  const [chat, gatsby, docs, releases, german] = await Promise.all(
    [
      "chat-transcript-en.txt",
      "great-gatsby-en.txt",
      "vite-plugin-api-en.txt",
      "github-releases-api.txt",
      "die-verwandlung-de.txt",
    ].map((file) => fsp.readFile(path.resolve(textsDir, file), "utf-8")),
  );
  const paragraphs = [
    chat!,
    ...gatsby!.split("\n"),
    ...docs!.split("\n\n"),
    ...german!.split("\n"),
  ].filter(Boolean);
  const releaseItems = JSON.parse(releases!) as unknown[];

  const messages: ModelMessage[] = [
    { role: "system", content: paragraphs.slice(0, 3).join("\n") },
  ];
  for (let turn = 0; messages.length < 50; turn++) {
    messages.push({
      role: "user",
      content: [
        { type: "text", text: paragraphs[(turn * 7) % paragraphs.length]! },
      ],
    });
    if (turn % 3 === 0) {
      const toolCallId = `call_${turn}`;
      messages.push({
        role: "assistant",
        content: [
          { type: "text", text: "Let me check the releases." },
          {
            type: "tool-call",
            toolCallId,
            toolName: "listReleases",
            input: { owner: "vitejs", repo: "vite", page: turn },
          },
        ],
      });
      messages.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId,
            toolName: "listReleases",
            output: {
              type: "json",
              value: releaseItems[turn % releaseItems.length] as never,
            },
          },
        ],
      });
    } else {
      messages.push({
        role: "assistant",
        content: [
          {
            type: "text",
            text: paragraphs[(turn * 11 + 5) % paragraphs.length]!,
          },
        ],
      });
    }
  }
  return messages.slice(0, 50);
}
