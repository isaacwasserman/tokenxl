import type { ModelMessage } from 'ai'
import type { WalkContext } from './context.ts'
import type { MessageBreakdown } from './types.ts'
import { Feature } from '../profile.ts'
import { addJson, addText, tallyValue } from './context.ts'

// The part shapes differ between AI SDK versions, so the walker reads parts
// structurally and ignores fields it does not know.
interface LoosePart {
  type: string
  [key: string]: unknown
}

export function walkMessage(message: ModelMessage, context: WalkContext, breakdown?: MessageBreakdown): void {
  const { tally } = context
  const start = breakdown ? tallyValue(context) : 0

  tally[Feature.perMessage]!++
  if (message.role === 'system')
    tally[Feature.perSystem]!++

  if (breakdown)
    breakdown.overhead = tallyValue(context) - start

  const content: unknown = message.content
  if (typeof content === 'string') {
    if (breakdown) {
      const partStart = tallyValue(context)
      addText(context, content)
      breakdown.parts.push({ type: 'text', total: tallyValue(context) - partStart })
    }
    else {
      addText(context, content)
    }
  }
  else if (Array.isArray(content)) {
    for (const part of content as LoosePart[]) {
      if (breakdown) {
        const partStart = tallyValue(context)
        walkPart(part, context)
        breakdown.parts.push({ type: String(part.type), total: tallyValue(context) - partStart })
      }
      else {
        walkPart(part, context)
      }
    }
  }

  if (breakdown)
    breakdown.total = tallyValue(context) - start
}

function walkPart(part: LoosePart, context: WalkContext): void {
  const { tally } = context

  switch (part.type) {
    case 'text':
      addText(context, part.text as string)
      break

    case 'reasoning':
      tally[Feature.perReasoning]!++
      addText(context, part.text as string)
      break

    // Tool call IDs are not counted: they are high-entropy strings that the
    // text rules price badly, and `perToolCall` and `perToolResult` absorb
    // their average cost.
    case 'tool-call':
      tally[Feature.perToolCall]!++
      addText(context, part.toolName as string)
      addJson(context, part.input)
      break

    case 'tool-result':
      tally[Feature.perToolResult]!++
      walkToolOutput(part.output, context)
      break

    case 'image':
      tally[Feature.perImage]!++
      break

    case 'file':
    case 'reasoning-file':
      tally[isImageMediaType(part.mediaType) ? Feature.perImage : Feature.perFile]!++
      walkFileData(part.data, context)
      break

    // Unknown parts (`custom`, tool approvals) count zero tokens.
  }
}

function walkFileData(data: unknown, context: WalkContext): void {
  // Inline text is sent as text. Binary data and URLs are not read.
  if (isLoosePart(data) && data.type === 'text')
    addText(context, data.text as string)
}

function walkToolOutput(output: unknown, context: WalkContext): void {
  if (typeof output === 'string') {
    addText(context, output)
    return
  }
  if (!isLoosePart(output))
    return

  switch (output.type) {
    case 'text':
    case 'error-text':
      addText(context, output.value as string)
      break

    case 'json':
    case 'error-json':
      addJson(context, output.value)
      break

    case 'execution-denied':
      addText(context, output.reason as string | undefined)
      break

    case 'content':
      if (Array.isArray(output.value)) {
        for (const item of output.value)
          walkToolOutputContent(item, context)
      }
      break

    default:
      addJson(context, output.value)
  }
}

function walkToolOutputContent(item: unknown, context: WalkContext): void {
  if (!isLoosePart(item))
    return

  const { tally } = context
  const { type } = item

  if (type === 'text') {
    addText(context, item.text as string)
  }
  else if (type.startsWith('image')) {
    tally[Feature.perImage]!++
  }
  else if (type === 'media') {
    // AI SDK 5 uses one media type for images and files.
    tally[isImageMediaType(item.mediaType) ? Feature.perImage : Feature.perFile]!++
  }
  else if (type.startsWith('file')) {
    tally[isImageMediaType(item.mediaType) ? Feature.perImage : Feature.perFile]!++
    walkFileData(item.data, context)
  }
}

function isImageMediaType(mediaType: unknown): boolean {
  return typeof mediaType === 'string' && (mediaType === 'image' || mediaType.startsWith('image/'))
}

function isLoosePart(value: unknown): value is LoosePart {
  return typeof value === 'object' && value !== null && typeof (value as LoosePart).type === 'string'
}
