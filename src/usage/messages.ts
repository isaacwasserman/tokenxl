import type { ModelMessage } from "ai";
import { Feature } from "../profile.ts";
import type { WalkContext } from "./context.ts";
import { addJson, addText, tallyValue } from "./context.ts";
import type { MessageBreakdown } from "./types.ts";

// The part shapes differ between AI SDK versions, so the walker reads parts
// structurally and ignores fields it does not know.
interface LoosePart {
  type: string;
  [key: string]: unknown;
}

export function walkMessage(
  message: ModelMessage,
  context: WalkContext,
  breakdown?: MessageBreakdown,
): void {
  const { tally } = context;
  const start = breakdown ? tallyValue(context) : 0;

  tally[Feature.perMessage]!++;
  if (message.role === "system") tally[Feature.perSystem]!++;

  const content: unknown = message.content;
  // Encrypted reasoning carried by the message itself counts as message overhead.
  if (Array.isArray(content)) context.sentReasoning ??= new Set();
  const payloads =
    context.sentReasoning && Array.isArray(content)
      ? extractReasoningPayloads(message, context.sentReasoning)
      : [];
  for (const { part, payload } of payloads) {
    if (!part) addReasoningPayload(context, payload);
  }

  if (breakdown) breakdown.overhead = tallyValue(context) - start;

  if (typeof content === "string") {
    if (breakdown) {
      const partStart = tallyValue(context);
      addText(context, content);
      breakdown.parts.push({
        type: "text",
        total: tallyValue(context) - partStart,
      });
    } else {
      addText(context, content);
    }
  } else if (Array.isArray(content)) {
    for (const part of content as LoosePart[]) {
      const partStart = breakdown ? tallyValue(context) : 0;
      walkPart(part, context);
      for (const entry of payloads) {
        if (entry.part === part) addReasoningPayload(context, entry.payload);
      }
      if (breakdown)
        breakdown.parts.push({
          type: String(part.type),
          total: tallyValue(context) - partStart,
        });
    }
  }

  if (breakdown) breakdown.total = tallyValue(context) - start;
}

// The provider decrypts a payload and charges the full hidden thinking instead
// of the visible summary, so the payload length is the estimate.
function addReasoningPayload(context: WalkContext, payload: string): void {
  context.tally[
    context.priorTurn
      ? Feature.previousReasoningPayloads
      : Feature.reasoningPayloads
  ]!++;
  context.tally[
    context.priorTurn
      ? Feature.previousReasoningPayloadChars
      : Feature.reasoningPayloadChars
  ]! += payload.length;
}

function walkPart(part: LoosePart, context: WalkContext): void {
  const { tally } = context;

  switch (part.type) {
    case "text":
      addText(context, part.text as string);
      break;

    case "reasoning": {
      // Its payload, charged by the message walk, replaces the summary text.
      if (carriesReasoningPayload(part)) break;
      // A stored OpenAI item, sent as a reference: the AI SDK splits it into
      // a part per summary. Charge the item once and each summary's text.
      const item = (
        part.providerOptions as { openai?: { itemId?: unknown } } | undefined
      )?.openai?.itemId;
      const key = typeof item === "string" && item ? `openai-item:${item}` : "";
      context.sentReasoning ??= new Set();
      if (!key || !context.sentReasoning.has(key))
        tally[Feature.perReasoning]!++;
      if (key) context.sentReasoning.add(key);
      addText(context, part.text as string);
      break;
    }

    // Tool call IDs are not counted: they are high-entropy strings that the
    // text rules price badly, and `perToolCall` and `perToolResult` absorb
    // their average cost.
    case "tool-call":
      tally[Feature.perToolCall]!++;
      addText(context, part.toolName as string);
      addJson(context, part.input);
      break;

    case "tool-result":
      tally[Feature.perToolResult]!++;
      walkToolOutput(part.output, context);
      break;

    case "image":
      tally[Feature.perImage]!++;
      break;

    case "file":
    case "reasoning-file":
      tally[
        isImageMediaType(part.mediaType) ? Feature.perImage : Feature.perFile
      ]!++;
      walkFileData(part.data, context);
      break;

    // Unknown parts (`custom`, tool approvals) count zero tokens.
  }
}

interface ProviderOptionsShape {
  anthropic?: { signature?: unknown; redactedData?: unknown };
  openai?: { itemId?: unknown; reasoningEncryptedContent?: unknown };
  openrouter?: { reasoning_details?: unknown };
}

interface OpenRouterDetail {
  type?: unknown;
  format?: unknown;
  data?: unknown;
  signature?: unknown;
}

const providerOptions = (value: object): ProviderOptionsShape | undefined =>
  (value as { providerOptions?: unknown }).providerOptions as
    | ProviderOptionsShape
    | undefined;
const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;
function details(value: object): OpenRouterDetail[] | undefined {
  const list = providerOptions(value)?.openrouter?.reasoning_details;
  return Array.isArray(list) && list.length
    ? (list as OpenRouterDetail[])
    : undefined;
}

/** Whether a reasoning part carries encrypted reasoning, whose cost replaces its text. */
export function carriesReasoningPayload(part: {
  type: string;
  providerOptions?: unknown;
}): boolean {
  const options = providerOptions(part);
  return (
    part.type === "reasoning" &&
    (nonEmpty(options?.anthropic?.signature) ||
      nonEmpty(options?.anthropic?.redactedData) ||
      nonEmpty(options?.openai?.reasoningEncryptedContent) ||
      details(part) !== undefined)
  );
}

/**
 * The encrypted reasoning payloads a message sends, each with the part that
 * carries it (none when the message itself carries it), as each provider's AI
 * SDK integration sends them. `sent` holds payloads already sent in the
 * request; each is sent once.
 */
export function extractReasoningPayloads(
  message: ModelMessage,
  sent: Set<string>,
): { part?: object; payload: string }[] {
  if (!Array.isArray(message.content)) return [];
  const parts = message.content as LoosePart[];
  const payloads: { part?: object; payload: string }[] = [];
  const add = (
    part: object | undefined,
    payload: unknown,
    key: string,
  ): void => {
    if (nonEmpty(payload) && !sent.has(key)) {
      sent.add(key);
      payloads.push({ ...(part ? { part } : {}), payload });
    }
  };
  for (const part of parts) {
    if (part.type !== "reasoning") continue;
    const options = providerOptions(part);
    // Anthropic: each part carries its signature, or redacted data.
    const anthropic = nonEmpty(options?.anthropic?.signature)
      ? options!.anthropic!.signature
      : options?.anthropic?.redactedData;
    add(part, anthropic, `anthropic:${String(anthropic)}`);
    // OpenAI: each part of a reasoning item repeats the item's encrypted content.
    const item = options?.openai?.itemId;
    add(
      part,
      options?.openai?.reasoningEncryptedContent,
      `openai:${nonEmpty(item) ? item : String(options?.openai?.reasoningEncryptedContent)}`,
    );
  }
  // OpenRouter: one detail list per message, from the message, the first tool
  // call, or the first reasoning part. Unsigned Anthropic and Gemini text
  // details are dropped; duplicates in the request are sent once.
  const carrier = details(message)
    ? undefined
    : (parts.find((part) => part.type === "tool-call" && details(part)) ??
      parts.find((part) => part.type === "reasoning" && details(part)));
  for (const detail of details(carrier ?? message) ?? []) {
    // A signed text detail is decrypted from its signature; an unsigned one,
    // from an open model, is sent as its text.
    const unsigned =
      detail.type === "reasoning.text" &&
      !nonEmpty(detail.signature) &&
      detail.format !== "anthropic-claude-v1" &&
      detail.format !== "google-gemini-v1";
    const payload =
      detail.type === "reasoning.encrypted"
        ? detail.data
        : unsigned
          ? (detail as { text?: unknown }).text
          : detail.type === "reasoning.text"
            ? detail.signature
            : undefined;
    add(carrier, payload, `openrouter:${JSON.stringify(detail)}`);
  }
  return payloads;
}

function walkFileData(data: unknown, context: WalkContext): void {
  // Inline text is sent as text. Binary data and URLs are not read.
  if (isLoosePart(data) && data.type === "text")
    addText(context, data.text as string);
}

function walkToolOutput(output: unknown, context: WalkContext): void {
  if (typeof output === "string") {
    addText(context, output);
    return;
  }
  if (!isLoosePart(output)) return;

  switch (output.type) {
    case "text":
    case "error-text":
      addText(context, output.value as string);
      break;

    case "json":
    case "error-json":
      addJson(context, output.value);
      break;

    case "execution-denied":
      addText(context, output.reason as string | undefined);
      break;

    case "content":
      if (Array.isArray(output.value)) {
        for (const item of output.value) walkToolOutputContent(item, context);
      }
      break;

    default:
      addJson(context, output.value);
  }
}

function walkToolOutputContent(item: unknown, context: WalkContext): void {
  if (!isLoosePart(item)) return;

  const { tally } = context;
  const { type } = item;

  if (type === "text") {
    addText(context, item.text as string);
  } else if (type.startsWith("image")) {
    tally[Feature.perImage]!++;
  } else if (type === "media") {
    // AI SDK 5 uses one media type for images and files.
    tally[
      isImageMediaType(item.mediaType) ? Feature.perImage : Feature.perFile
    ]!++;
  } else if (type.startsWith("file")) {
    tally[
      isImageMediaType(item.mediaType) ? Feature.perImage : Feature.perFile
    ]!++;
    walkFileData(item.data, context);
  }
}

function isImageMediaType(mediaType: unknown): boolean {
  return (
    typeof mediaType === "string" &&
    (mediaType === "image" || mediaType.startsWith("image/"))
  );
}

function isLoosePart(value: unknown): value is LoosePart {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as LoosePart).type === "string"
  );
}
