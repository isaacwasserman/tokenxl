import type { ModelMessage, ToolSet } from "ai";
import type { ResolvedModelProfile } from "../profile.ts";
import { compileProfile, Feature } from "../profile.ts";
import { countTextTokens } from "../segments.ts";
import { carriesReasoningPayload } from "../usage/messages.ts";
import type { UsageInput } from "../usage/types.ts";
import type { CollectionOptions, Sample } from "./collect.ts";
import { collectSamples, mapConcurrent } from "./collect.ts";
import { measureErrors, solveLeastSquares, summarizeErrors } from "./fit.ts";
import type {
  ErrorMetrics,
  FieldReport,
  ModelInvoker,
  ReasoningMetrics,
  TokenUsage,
} from "./types.ts";

// Current-turn and previous-turn tally slots: blocks, then characters.
const SLOTS = [
  Feature.reasoningPayloads,
  Feature.reasoningPayloadChars,
  Feature.previousReasoningPayloads,
  Feature.previousReasoningPayloadChars,
] as const;

// Matched topics and answer lengths, fixed before looking at any counts. The
// tasks need enough thought that the model reasons at ordinary effort levels.
const PROMPTS = [
  "How many binary strings of length 12 have exactly five ones and no three consecutive ones? Check the constraints. Give the number and a short explanation.",
  "Review this cache design: Map<string, Promise<Result>>, insert before await, delete on rejection, capacity 100 using insertion order. Two concurrent callers request the same missing key while another insertion evicts it. Identify races and propose a correct bounded design. Answer in at most 180 words.",
  "Find a schedule for jobs A(3), B(2), C(4), D(1), E(2) on two workers. C depends on A; D depends on B; E depends on C and D. Minimize completion time and justify optimality briefly.",
  "A bag has four red, three blue and two green balls. Draw four without replacement. What is the probability of seeing all three colors? Show a short check.",
] as const;

// Tool-use conversations put reasoning in the current turn: the history ends
// with a tool result, so the reasoning before the tool call is not in an
// earlier turn. Plain JSON Schema keeps the tuner free of runtime dependencies.
const TOOLS = {
  get_order_status: {
    description: "Look up the shipping status of an order.",
    inputSchema: {
      type: "object",
      properties: { order_id: { type: "string" } },
      required: ["order_id"],
    },
  },
  get_exchange_rate: {
    description: "Look up the current exchange rate between two currencies.",
    inputSchema: {
      type: "object",
      properties: { from: { type: "string" }, to: { type: "string" } },
      required: ["from", "to"],
    },
  },
} as unknown as ToolSet;
const TOOL_RESULTS: Record<string, unknown> = {
  get_order_status: {
    status: "delayed",
    carrier: "DHL",
    estimated_delivery: "2026-10-09",
    reason: "storm at the regional hub",
  },
  get_exchange_rate: { rate: 162.37, as_of: "2026-10-06T09:00:00Z" },
};
// Each prompt needs reasoning before the call, from a short step to a longer
// derivation, so current-turn blocks cover short and long payloads.
const TOOL_PROMPTS = [
  "Use get_order_status. The order ID is the number of ways to climb 12 stairs taking 1 or 2 steps at a time. Work it out before you call the tool, then tell the customer when the order should arrive. Answer in at most 100 words.",
  "Use get_exchange_rate. The client is paid in the currency of the country whose capital is Canberra and spends in the currency of the country whose capital is Wellington. Decide the pair before you call the tool, then convert 2,400 units and add a 1.2% fee. Answer in at most 100 words.",
] as const;

// The first conversations get a second response, so histories vary block
// counts independently of payload lengths.
const SECOND_RESPONSES = 2;
const CHALLENGE =
  "Check the strongest possible counterexample to your answer, revise if needed, and answer in at most 120 words.";
const CLOSE = "Thank you. Please continue.";

/** The maximum number of `invokeModel` calls. */
export const REASONING_INVOCATIONS: number =
  PROMPTS.length + SECOND_RESPONSES + 2 * TOOL_PROMPTS.length;

interface Conversation {
  prompt: string;
  responses: number;
  tools?: ToolSet;
  histories: UsageInput[];
}

/** Build conversations from the built-in prompts by alternating model responses with follow-up messages or tool results. */
export async function generateHistories(
  invokeModel: ModelInvoker,
  options: {
    concurrency?: number;
    signal?: AbortSignal;
    onProgress?: () => void;
    onCall?: (call: { start: number; end: number; usage?: TokenUsage }) => void;
  },
): Promise<{ histories: UsageInput[]; invocations: number }> {
  const conversations: Conversation[] = [
    ...PROMPTS.map((prompt, index) => ({
      prompt,
      responses: index < SECOND_RESPONSES ? 2 : 1,
      histories: [],
    })),
    ...TOOL_PROMPTS.map((prompt) => ({
      prompt,
      responses: 2,
      tools: TOOLS,
      histories: [],
    })),
  ];
  let invocations = 0;
  await mapConcurrent(
    conversations,
    options.concurrency ?? 4,
    options.signal,
    async (task) => {
      let history: UsageInput = {
        messages: [{ role: "user", content: task.prompt }],
        ...(task.tools ? { tools: task.tools } : {}),
      };
      for (let turn = 0; turn < task.responses; turn++) {
        options.signal?.throwIfAborted();
        invocations++;
        const start = performance.now();
        const result = await invokeModel(history, { signal: options.signal });
        const response =
          result === null || Array.isArray(result)
            ? (result as readonly ModelMessage[] | null)
            : (result as { messages: readonly ModelMessage[] | null }).messages;
        const usage =
          result && !Array.isArray(result)
            ? (result as { usage?: TokenUsage }).usage
            : undefined;
        options.onCall?.({
          start,
          end: performance.now(),
          ...(usage ? { usage } : {}),
        });
        options.signal?.throwIfAborted();
        options.onProgress?.();
        if (!response?.length) break;
        const calls = response.flatMap((message) =>
          message.role === "assistant" && Array.isArray(message.content)
            ? message.content.filter((part) => part.type === "tool-call")
            : [],
        );
        if (calls.length) {
          // Answer every call; the history ends in the current turn.
          const results: ModelMessage = {
            role: "tool",
            content: calls.map((call) => ({
              type: "tool-result",
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              output: {
                type: "json",
                value: (TOOL_RESULTS[call.toolName] ?? {
                  error: "unknown tool",
                }) as never,
              },
            })),
          };
          history = {
            ...history,
            messages: [...history.messages, ...response, results],
          };
          task.histories.push(history);
          continue;
        }
        history = {
          ...history,
          messages: [
            ...history.messages,
            ...response,
            {
              role: "user",
              content:
                turn + 1 < task.responses && !task.tools ? CHALLENGE : CLOSE,
            },
          ],
        };
        task.histories.push(history);
        if (task.tools) break;
      }
    },
  );
  return {
    histories: conversations.flatMap((task) => task.histories),
    invocations,
  };
}

interface ReasoningFit {
  profile: ResolvedModelProfile;
  /** Why the costs kept their initial values, if they did. */
  reason?: FieldReport["reason"];
  /** Histories with reasoning in each turn; without both, `countReasoningInPreviousTurns` is not measured. */
  histories: { currentTurn: number; previousTurns: number };
  counterCalls: number;
  metrics: ReasoningMetrics;
}

/**
 * Fit the per-block and per-character costs of encrypted reasoning payloads,
 * and whether previous turns count them. Each history is counted twice, with and
 * without its payload parts, so text and structural errors do not enter the
 * coefficients.
 */
export async function fitReasoning(
  samples: readonly UsageInput[],
  initial: ResolvedModelProfile,
  options: CollectionOptions,
): Promise<ReasoningFit> {
  const measured = await collectPairs(samples, initial, options);
  const rows = measured.pairs
    .filter((pair) => SLOTS.some((slot) => pair.with.tally[slot]! > 0))
    .map((pair) => {
      const actual = pair.with.actual - pair.without.actual;
      // Subtract the locked costs of anything else that changed, such as a removed empty message.
      // Weighting by the measured cost minimizes relative error, so long histories do not dominate.
      return {
        x: SLOTS.map(
          (slot) => pair.with.tally[slot]! - pair.without.tally[slot]!,
        ),
        target: actual - computeLockedDifference(pair, initial),
        weight: 1 / Math.max(1, actual) ** 2,
      };
    });
  // Providers either count previous-turn reasoning at the cost it has in the
  // current turn, or drop it. Fit both cases and keep the better one.
  const merged = rows.map((row) => ({
    ...row,
    x: [row.x[0]! + row.x[2]!, row.x[1]! + row.x[3]!],
  }));
  const currentOnly = rows.map((row) => ({
    ...row,
    x: [row.x[0]!, row.x[1]!],
  }));
  const counted = (data: typeof merged): number =>
    data.filter((row) => row.x[0]! > 0).length;
  const candidates = (
    [
      [true, merged],
      [false, currentOnly],
    ] as const
  ).flatMap(([previousTurns, data]) => {
    const solution = counted(data) >= 2 ? solveWeighted(data) : undefined;
    if (!solution || !Number.isFinite(solution[0]) || !(solution[1]! > -1e-9))
      return [];
    const [block, char] = [solution[0]!, Math.max(0, solution[1]!)];
    // The per-block cost becomes an envelope length: block = -char × envelope.
    if (char < 1e-9 && Math.abs(block) > 1e-6) return [];
    const envelope = char < 1e-9 ? 0 : -block / char;
    const loss = data.reduce(
      (sum, row) =>
        sum +
        row.weight * (row.x[0]! * block + row.x[1]! * char - row.target) ** 2,
      0,
    );
    return [{ previousTurns, char, envelope, loss }];
  });
  const best = candidates.reduce<(typeof candidates)[number] | undefined>(
    (best, candidate) =>
      !best || candidate.loss < best.loss ? candidate : best,
    undefined,
  );
  const reason = best
    ? undefined
    : counted(merged) < 2
      ? "absent"
      : solveWeighted(merged)
        ? "invalid"
        : "collinear";
  const profile: ResolvedModelProfile = best
    ? {
        ...initial,
        perReasoningPayloadChar: best.char,
        reasoningPayloadEnvelopeChars: best.envelope,
        countReasoningInPreviousTurns: best.previousTurns,
      }
    : initial;
  return {
    profile,
    ...(reason ? { reason } : {}),
    histories: {
      currentTurn: rows.filter((row) => row.x[0]! > 0).length,
      previousTurns: rows.filter((row) => row.x[2]! > 0).length,
    },
    counterCalls: measured.counterCalls,
    metrics: reportErrors(measured.pairs, initial, profile),
  };
}

/**
 * The costs of stored OpenAI reasoning items, which the AI SDK sends as
 * references without their payload. The fitted payload cost of each generated
 * OpenAI item is its hidden reasoning; the summary scale is the ratio of the
 * total hidden cost to the total estimated summary tokens, and the cost of an
 * item without summary is the mean. Fields without items keep their values.
 */
export function fitStoredReasoning(
  histories: readonly UsageInput[],
  profile: ResolvedModelProfile,
): {
  profile: ResolvedModelProfile;
  items: number;
  summarized: number;
} {
  const text = compileProfile(profile, false).text;
  // Later histories repeat earlier items; a set keeps each summary once.
  const items = new Map<string, { payload: number; summaries: Set<string> }>();
  for (const history of histories)
    for (const message of history.messages) {
      if (!Array.isArray(message.content)) continue;
      for (const part of message.content as {
        type: string;
        text?: string;
        providerOptions?: {
          openai?: { itemId?: unknown; reasoningEncryptedContent?: unknown };
        };
      }[]) {
        const openai = part.providerOptions?.openai;
        if (
          part.type !== "reasoning" ||
          typeof openai?.itemId !== "string" ||
          typeof openai.reasoningEncryptedContent !== "string"
        )
          continue;
        const item = items.get(openai.itemId) ?? {
          payload: openai.reasoningEncryptedContent.length,
          summaries: new Set(),
        };
        if (part.text) item.summaries.add(part.text);
        items.set(openai.itemId, item);
      }
    }
  let cost = 0;
  let tokens = 0;
  let emptyCost = 0;
  let empty = 0;
  for (const { payload, summaries } of items.values()) {
    const hidden =
      profile.perReasoningPayloadChar *
      Math.max(0, payload - profile.reasoningPayloadEnvelopeChars);
    let summaryTokens = 0;
    for (const summary of summaries)
      summaryTokens += countTextTokens(summary, text);
    if (summaryTokens > 0) {
      cost += hidden;
      tokens += summaryTokens;
    } else {
      emptyCost += hidden;
      empty++;
    }
  }
  return {
    profile: {
      ...profile,
      ...(tokens > 0 ? { storedReasoningSummaryScale: cost / tokens } : {}),
      ...(empty > 0 ? { perStoredReasoning: emptyCost / empty } : {}),
    },
    items: items.size,
    summarized: items.size - empty,
  };
}

/** Weighted least squares on both columns; `undefined` when they are not independent. */
function solveWeighted(
  rows: { x: number[]; target: number; weight: number }[],
): number[] | undefined {
  const { coefficients, reasons } = solveLeastSquares(
    rows.map((row) => row.x.map((value) => value * Math.sqrt(row.weight))),
    rows.map((row) => row.target * Math.sqrt(row.weight)),
  );
  return reasons.size ? undefined : (coefficients as number[]);
}

// The same control object lets shared observations reuse counts across fits.
const controls = new WeakMap<UsageInput, UsageInput>();

/** Remove reasoning parts with encrypted payloads, and any message left empty. Returns the input itself if nothing changes. */
export function removeReasoningPayloads(input: UsageInput): UsageInput {
  let control = controls.get(input);
  if (!control) {
    control = removePayloads(input);
    controls.set(input, control);
  }
  return control;
}

// OpenRouter details can also sit on the message or a tool call; they go with the reasoning.
function removeOpenRouterDetails<T extends object>(value: T): T {
  const options = (
    value as {
      providerOptions?: Record<string, Record<string, unknown> | undefined>;
    }
  ).providerOptions;
  if (!options?.openrouter?.reasoning_details) return value;
  const { reasoning_details: _, ...openrouter } = options.openrouter;
  return { ...value, providerOptions: { ...options, openrouter } };
}

function removePayloads(input: UsageInput): UsageInput {
  let changed = false;
  const messages = input.messages.flatMap((message): ModelMessage[] => {
    if (!Array.isArray(message.content)) return [message];
    const content = (
      message.content as { type: string; providerOptions?: unknown }[]
    )
      .filter((part) => !carriesReasoningPayload(part))
      .map((part) =>
        part.type === "tool-call" ? removeOpenRouterDetails(part) : part,
      );
    const stripped = removeOpenRouterDetails(message);
    if (
      content.length === message.content.length &&
      content.every((part, n) => part === message.content[n]) &&
      stripped === message
    )
      return [message];
    changed = true;
    return content.length ? [{ ...stripped, content } as ModelMessage] : [];
  });
  return changed ? { ...input, messages } : input;
}

interface Pair {
  with: Sample;
  without: Sample;
}

async function collectPairs(
  inputs: readonly UsageInput[],
  initial: ResolvedModelProfile,
  options: CollectionOptions,
): Promise<{ pairs: Pair[]; counterCalls: number }> {
  // Histories without payloads are their own control and are counted once.
  const data = await collectSamples(
    [...inputs, ...inputs.map(removeReasoningPayloads)],
    initial,
    options,
  );
  const pairs = inputs.map((_, n) => ({
    with: data.samples[data.inputIndices[n]!]!,
    without: data.samples[data.inputIndices[inputs.length + n]!]!,
  }));
  return { pairs, counterCalls: data.counterCalls };
}

const REASONING_FEATURES = new Set<number>(SLOTS);

function computeLockedDifference(
  pair: Pair,
  profile: ResolvedModelProfile,
): number {
  const weights = compileProfile(profile).weights;
  let value = 0;
  for (let index = 0; index < weights.length; index++) {
    if (!REASONING_FEATURES.has(index))
      value +=
        (pair.with.tally[index]! - pair.without.tally[index]!) *
        weights[index]!;
  }
  return value;
}

function reportErrors(
  pairs: Pair[],
  initial: ResolvedModelProfile,
  profile: ResolvedModelProfile,
): ReasoningMetrics {
  const reasoned = pairs.filter((pair) =>
    SLOTS.some((slot) => pair.with.tally[slot]! > 0),
  );
  const hidden = (fields: ResolvedModelProfile): ErrorMetrics => {
    const weights = compileProfile(fields).weights;
    return summarizeErrors(
      reasoned.map((pair) => ({
        actual: pair.with.actual - pair.without.actual,
        estimated:
          computeLockedDifference(pair, fields) +
          SLOTS.reduce(
            (sum, slot) =>
              sum +
              (pair.with.tally[slot]! - pair.without.tally[slot]!) *
                weights[slot]!,
            0,
          ),
      })),
    );
  };
  const requests = pairs.map((pair) => pair.with);
  return {
    reasoning: { before: hidden(initial), after: hidden(profile) },
    request: {
      before: measureErrors(requests, initial),
      after: measureErrors(requests, profile),
    },
  };
}
