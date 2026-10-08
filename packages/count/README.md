# @tokenxl/count

Fast and lightweight token count estimation without requiring a full tokenizer: text, AI SDK messages, tool schemas, images and reasoning.

A fork of [tokenx](https://github.com/johannschopplich/tokenx) by Johann Schopplich, with model profiles for request overhead. Tune profiles for other models with [`@tokenxl/tune`](https://github.com/isaacwasserman/tokenx/tree/main/packages/tune).

Default text estimates are calibrated against OpenAI's `o200k_base` encoding. Model profiles let you adjust text ratios and request overhead for other LLM families. For precise counts, use a full tokenizer like [`gpt-tokenizer`](https://github.com/niieani/gpt-tokenizer).

## Features

- ⚡ **95%+ average accuracy**, and no single sample below 90%
- 📦 No runtime dependencies or tokenizer data files
- 🖥️ **[Bundled CLI](#cli)** – count, slice and split from the shell
- 🧰 AI SDK ModelMessage and tool estimation with configurable model profiles
- 🔎 Optional breakdown by message, tool and schema property
- 🌍 Multi-language support with configurable language rules
- 🗣️ Built-in rules for accented scripts (German, French, Spanish, Slavic), Cyrillic, and Greek
- 🀄 CJK (Chinese, Japanese, Korean) character handling
- 😀 Emoji-aware pricing (emoji cost more tokens than their character count suggests)

## Benchmarks

`pnpm benchmark` compares the estimates with OpenAI's `o200k_base` counts on the sample corpus and prints a chart of each sample's deviation, then times tokenxl against gpt-tokenizer and ai-tokenizer; the mean deviation is about 3.7%, and every sample stays within ±10%.

Accuracy depends on the kind of text, not its length: a short excerpt deviates about as much as the full document it came from. A holdout corpus that no ratio was ever fitted against is held to a looser ±15% bound, so a retune cannot silently overfit the chart.

Three cases are knowingly outside these bounds, all underestimates:

- **High-entropy strings** – base64, hashes, digests: ≈-70%. Pricing them would cost every caller runtime for a case ordinary traffic rarely carries.
- **Traditional and classical Chinese** – the hanzi rate is calibrated on contemporary simplified script: ≈-10% to -20%.
- **Scripts without a built-in rule** – Arabic ≈-35%, Hindi ≈-30%, Hebrew ≈-45%, Thai ≈-60%; a custom language rule closes the gap.

## Installation

```bash
# npm
npm install @tokenxl/count

# pnpm
pnpm add @tokenxl/count

# yarn
yarn add @tokenxl/count
```

## CLI

The package ships a `tokenxl` binary – no install needed via `npx`, or install it for the commands below.

```bash
# Count tokens in a file, a pipe, or several files at once
tokenxl README.md
cat article.md | tokenxl
tokenxl count src/*.ts

# Fail a script when a prompt outgrows its budget (exit code 2)
tokenxl prompt.txt --limit 8000

# Count with a model's tuned text rules
tokenxl prompt.txt --profile anthropic/claude-sonnet-5.5

# Extract a token range, or chunk a document for RAG
tokenxl slice article.md --end 500
tokenxl split article.md --size 500 --overlap 50
```

Only results go to stdout – counts as bare integers, chunks as a JSON array – so `$(tokenxl count file.txt)` and `| jq` work unchanged. Notices and errors go to stderr. Run `tokenxl --help` for every option.

## Usage

```ts
import { estimateTokenCount, isWithinTokenLimit, sliceByTokens, splitByTokens } from '@tokenxl/count'

const text = 'Your text goes here.'

// Estimate the number of tokens in the text
const estimatedTokens = estimateTokenCount(text)
console.log(`Estimated token count: ${estimatedTokens}`)

// Check if text is within a specific token limit
const tokenLimit = 1024
const withinLimit = isWithinTokenLimit(text, tokenLimit)
console.log(`Is within token limit: ${withinLimit}`)

// Slice text by token positions (like Array.slice)
const firstTokens = sliceByTokens(text, 0, 5)
console.log(`First ~5 tokens: ${firstTokens}`)

// Split text into token-based chunks
const chunks = splitByTokens(text, 100)
console.log(`Split into ${chunks.length} chunks`)

// Use custom options for different languages or models.
// Custom language rules are checked before all built-in heuristics,
// so they can also override the built-in CJK handling.
const customOptions = {
  defaultCharsPerToken: 4, // More conservative estimation
  languageConfigs: [
    { pattern: /[\u4E00-\u9FFF]/, averageCharsPerToken: 2 }, // Custom Chinese rule
  ]
}

const customEstimate = estimateTokenCount(text, customOptions)
console.log(`Custom estimate: ${customEstimate}`)
```

## Estimate a request

Use `createUsageEstimator` for repeated requests to one model. It accepts AI SDK v5–v7 `ModelMessage` arrays and `ToolSet` objects. Convert UI messages to model messages before estimating. The `ai` peer dependency is optional; plain-text callers do not need it, and @tokenxl/count never imports it at runtime.

```ts
import type { ModelMessage } from 'ai'
import { tool } from 'ai'
import { createUsageEstimator, estimateUsage } from '@tokenxl/count'
import { z } from 'zod'

const estimator = createUsageEstimator({
  contentMultiplier: 1.1,
  baseOverhead: 6,
  perMessage: 2,
  toolsExist: 317,
  perTool: 53,
  perDesc: 5,
  perFirstProp: 13,
  perAdditionalProp: 12,
  perPropDesc: 5,
  perEnum: 9,
  perNestedObject: 12,
  perArrayOfObjects: 13,
})
const messages: ModelMessage[] = [{ role: 'user', content: 'What is the weather in Boston?' }]
const tools = {
  weather: tool({
    description: 'Get the weather for a city',
    inputSchema: z.object({ city: z.string().describe('City name') }),
  }),
}
const input = { messages, tools }
const total = estimator.count(input)
const breakdown = estimator.count(input, { breakdown: true })
console.log(total, breakdown.messages, breakdown.tools.definitions.weather)

// One-off calls can use the default profile or a shared profile object.
console.log(estimateUsage(input))
```

All `ModelProfile` fields are optional and JSON-safe. `resolveProfile(profile)` fills missing fields from `DEFAULT_PROFILE` and missing text rules from `DEFAULT_TEXT_PROFILE`; `estimator.profile` exposes the resolved values. The defaults are model-neutral: the o200k text rules of plain tokenx and approximate request overhead. The example above illustrates custom values; it is not a calibrated profile for a specific model. Automatic tuning is available through [`@tokenxl/tune`](https://github.com/isaacwasserman/tokenx/tree/main/packages/tune).

The estimate is the sum of structural costs and `contentMultiplier × textTokens`, rounded once at the end. The multiplier applies to message text, tool names, descriptions, property names, required names, enum values, and serialized tool-call inputs and JSON results. Each message adds `perMessage`, and system messages additionally add `perSystem`. Tool-call IDs are omitted; their average cost can be absorbed into `perToolCall` and `perToolResult`. Unknown message parts count zero and appear in the breakdown.

| Profile field | Default | Applied to |
| --- | ---: | --- |
| `contentMultiplier` | 1 | All estimated text |
| `baseOverhead` | 3 | Every request, including an empty request |
| `perMessage` / `perSystem` | 4 / 0 | Each message / each system message |
| `toolsExist` | 24 | Once when any tools exist |
| `perTool` | 6 | Each tool after the first |
| `perDesc` | 2 | Each nonempty tool description |
| `perFirstProp` / `perAdditionalProp` | 5 / 3 | First / subsequent property at each object level |
| `perPropDesc` | 2 | Each nonempty property description |
| `perEnum` | 7 | Each enum or const, plus its text |
| `perEnumValue` | 0 | Each enum member, in addition to `perEnum` and its text; const uses only `perEnum` |
| `perRequired` / `perRequiredProp` | 0 / 0 | Each present `required` array, including empty arrays / each required name, plus its text |
| `perAdditionalProperties` | 0 | Each explicit `additionalProperties` keyword |
| `perAdditionalPropertiesTrue` | 0 | Each `additionalProperties` that is `true` or a schema, in addition to `perAdditionalProperties` |
| `perUnionMember` / `perUnionBranch` | 0 / 0 | Each type after the first in a type list, and each `nullable: true` / each `anyOf` or `oneOf` branch after the first |
| `perSchemaKeyword` / `perAdditionalSchemaKeyword` | 0 / 0 | The first / each further annotation keyword of a schema node (`format`, `pattern`, `minimum`, `maxLength`, `default`, `title`, `examples` and similar), including its value |
| `perInteger` / `perBoolean` | 0 / 0 | Each schema node with an integer / boolean type |
| `perArrayOfPrimitives` | 0 | Each primitive array item schema, including union branches |
| `perNestedObject` / `perArrayOfObjects` | -3 / 1 | Object properties / object array items |
| `perToolCall` / `perToolResult` | 0 / 0 | Each call / result part |
| `perParallelToolCalls` | 0 | Each message with two or more tool calls |
| `perImage` / `perFile` | 85 / 100 | Each image / file part; with `perImagePatch`, the fixed cost of an image besides its patches |
| `perImagePatch` | 0 | Each patch of an image after the provider resizes it |
| `perToolResultImage` | 0 | Each image in a tool result, in addition to its image cost |
| `imagePatchSize` | 28 | The edge of an image patch, in pixels |
| `imageMaxEdge` / `imageMaxShortEdge` / `imageMaxPatches` | 0 / 0 / 0 | The longest edge, longest short edge, and most patches the provider keeps; 0 is no limit |
| `perReasoning` | 0 | Each reasoning part without an encrypted payload, plus its text |
| `perReasoningPayloadChar` | 0.43 | Each character of an encrypted reasoning payload after its envelope; the summary text is not counted |
| `reasoningPayloadEnvelopeChars` | 0 | Characters at the start of each payload that cost nothing (the encryption envelope) |
| `countReasoningInPreviousTurns` | `true` | Whether encrypted reasoning before the last user message is counted; `false` for models that drop it |
| `perStoredReasoning` | 173 | Each stored OpenAI reasoning item without summary text |
| `storedReasoningSummaryScale` | 2.3 | Each estimated token of the summary text of a stored OpenAI reasoning item |

An image costs `perImage + perImagePatch × patches`. The estimator reads the width and height from the header of PNG, GIF, WebP and JPEG data (bytes, base64, data URLs, or AI SDK 7 tagged data). It scales the image down to fit `imageMaxEdge` and `imageMaxShortEdge`, then steps the long edge down until the image has at most `imageMaxPatches` patches, and counts `ceil(width / imagePatchSize) × ceil(height / imagePatchSize)` patches. An image of unknown size, such as a URL, counts as 1024 × 1024 pixels. With the default `perImagePatch: 0`, every image costs `perImage`. The OpenAI `detail` setting is not read; the estimates assume the default detail. Generic file parts with an image media type, including AI SDK v7 `mediaType: 'image'`, are images. File costs are fixed estimates independent of file length; inline file text supported by the SDK is counted as text in addition to the file cost.

The additional schema weights default to zero. Required names now contribute text even with zero weights; retune existing profiles that were calibrated with required schemas. Controlled probes distinguish list framing from per-entry costs, enum framing from cardinality, keyword presence from omission, and scalar array items from object items.

### Predefined profiles

The [profile registry](https://github.com/isaacwasserman/tokenx/blob/main/packages/count/src/profiles.json) includes calibrated `anthropic/claude-opus-5.5`, `anthropic/claude-sonnet-4.5`, `anthropic/claude-sonnet-5.5`, `openai/gpt-5.1`, and `openai/gpt-6.1-sol` profiles, keyed as `provider/model` in OpenRouter's naming. The OpenAI profiles use the default text rules with their own measured overheads. Add a model with `pnpm tune` from [`@tokenxl/tune`](https://github.com/isaacwasserman/tokenx/tree/main/packages/tune). `ModelId` is derived from its keys, so TypeScript accepts only model IDs with a predefined profile.

```ts
import { createUsageEstimator, estimateTokenCount, estimateUsage, MODEL_PROFILES } from '@tokenxl/count'

const estimator = createUsageEstimator('anthropic/claude-sonnet-5.5')
const tokens = estimateUsage(input, { profile: 'anthropic/claude-sonnet-5.5' })
const textTokens = estimateTokenCount('Hello world', { profile: 'anthropic/claude-sonnet-5.5' })
const profile = MODEL_PROFILES['anthropic/claude-sonnet-5.5']
```

Omit `profile` to use the existing defaults. Custom profile objects are also accepted. The text APIs use text rules and a multiplier without request overhead; direct text options override the profile's ratios. `sliceByTokens`, `splitByTokens`, and `isWithinTokenLimit` accept the same `profile` option. Shared predefined profiles are immutable. Unsupported model IDs throw for JavaScript callers.

#### Reasoning

Reasoning models return an encrypted payload with each reasoning part (Anthropic `signature` or `redactedData`, OpenAI `reasoningEncryptedContent` with `store: false`, OpenRouter `reasoning_details`). When the history is sent back, the provider charges the hidden thinking inside it, not the visible summary, so the payload's length is the estimate:

```text
reasoning part with an encrypted payload = perReasoningPayloadChar * (payload length - reasoningPayloadEnvelopeChars)
                                          (0 before the last user message when countReasoningInPreviousTurns is false)
other reasoning part                     = perReasoning + its text
```

The envelope is the part of every payload that holds no thinking. Reasoning before the last user message belongs to an earlier turn; some models charge it in full (`countReasoningInPreviousTurns: true`: Claude Sonnet 5.5, GPT-6.1 Sol) and others drop it (`false`: Claude Sonnet 4.5, GPT-5.1). OpenAI reasoning parts that share an `itemId` are charged once. The costs belong to the model, not to the reasoning level, and the defaults are an upper bound of the measured models, so a request without a profile overestimates reasoning.

Stored OpenAI items (the AI SDK default `store: true`) have an `itemId` and no encrypted content. The AI SDK sends them as references, and the provider charges the hidden reasoning (its reasoning tokens + 2), whose length the messages do not hold. The summaries are the best clue:

```text
stored item with summary text    = storedReasoningSummaryScale * estimated summary tokens
stored item without summary text = perStoredReasoning
```

Over many items the total is about right (aggregate error 0% on 150 measured items), but one item can be off by half or more, because the summary length varies with the hidden length only loosely. A stored item that also has `reasoningEncryptedContent` is estimated from its payload.

### Text ratios

Set `profile.text` to override the text rules. The same options are accepted by `estimateTokenCount`, `sliceByTokens`, `splitByTokens` and `isWithinTokenLimit`:

```ts
const estimator = createUsageEstimator({
  contentMultiplier: 1.05,
  text: {
    defaultCharsPerToken: 5,
    digitsPerToken: 3,
    hanziCharsPerToken: 1,
    languageCharsPerToken: { german: 2.8, emoji: 0.8 },
  },
})
```

| Text field | Default |
| --- | ---: |
| `defaultCharsPerToken` | 7 |
| `punctuationCharsPerToken` | 6 |
| `digitsPerToken` | 3 |
| `shortTokenThreshold` | 3 |
| `lowercaseWordMaxLength` | 8 |
| `innerUnderscoreTokens` | 0 |
| `hanziCharsPerToken` / `kanaCharsPerToken` / `hangulCharsPerToken` | 1.15 / 1.4 / 1.65 |
| `languageCharsPerToken` | german: 3, romance: 4.5, slavicLatin: 2.5, cyrillic: 6, greek: 3, emoji: 0.9 |
| `unaccentedWordScale` | german: 1, romance: 1, slavicLatin: 1 |

`innerUnderscoreTokens` prices a single underscore between a word and a letter, as in `snake_case` names. o200k joins it to the next word (0); Claude tokenizers charge about one token.

`unaccentedWordScale` scales the unaccented ASCII words of a text in German, a Romance language, or a Slavic language in Latin script. A tokenizer that splits these words more than English words needs a scale above 1. The language of a text comes from its accented words: when the accent rule of a language matches 5% or more of the words, its scale applies in full; below 5%, in proportion. Natural German and French prose has 10–15% accented words. Each text (each message text, tool description, and so on) gets its own scale.

Use positive, finite ratios and nonnegative integer thresholds. Custom `languageConfigs` on the text APIs replace the built-in language rules and take precedence over `languageCharsPerToken`. Profiles use the JSON-safe named language ratios.

### Schemas and caching

The estimator reads AI SDK `jsonSchema()` and `zodSchema()` wrappers, Standard JSON Schema (including Zod 4.2+), synchronous lazy schema functions, and plain JSON Schema objects. For other schema formats, pass a synchronous converter:

```ts
const estimator = createUsageEstimator(profile, {
  toJsonSchema: schema => convertToJsonSchema(schema),
})
const tokens = estimateUsage(input, { toJsonSchema: schema => convertToJsonSchema(schema) })
```

Every schema source must resolve synchronously. A promise or thenable throws `TypeError`; resolve it before calling the estimator. Unsupported schemas count only the tool name and description unless a converter is provided. Local `$ref` values resolve at each use site, with recursive references stopped and a depth limit of 64. Unused definitions and external references are not expanded. Optional and nullable schemas, enums, arrays, and `anyOf` / `oneOf` / `allOf` branches are walked.

By default, an estimator caches the cost of each tool object (in a `WeakMap`) and token estimates for up to 256 strings of at most 4,096 UTF-16 code units; the text APIs cache up to 8,192 repeated words between calls that pass no options or profile; a call with options or a profile caches only within that call. Reuse the estimator and tool objects to reuse those caches, and treat profile and tool objects as immutable once used. `estimateUsage` keeps one estimator per profile object, except with `toJsonSchema`, which creates an estimator for each call. Pass `cache: false` to `createUsageEstimator`, `estimateUsage`, or the text APIs to keep no state between calls; counting is then about 7–8× slower for repeated requests (measure with `pnpm benchmark`).

### Breakdown

`estimator.count(input, { breakdown: true })` and `estimateUsage(input, { breakdown: true })` return the same rounded `total` as ordinary counting, with:

- `baseOverhead` and `messages`, each with `role`, `total`, `overhead`, and `parts`.
- `tools.total`, `tools.overhead`, and `tools.definitions` keyed by tool name.
- Each definition's `name`, `description`, and `inputSchema` costs.
- `inputSchema.overhead` includes root schema keywords and required-name text.
- Schema properties keyed by paths such as `filter.kind` and `rows[].id`, each with `name`, `overhead`, `description`, `enum`, `nested`, and `total`.

Component values retain fractions; only the request total is rounded. A parent property's `nested` includes its children's costs, so sum root properties and `inputSchema.overhead` when reconciling a schema total. Repeated paths in union branches are aggregated. Ordinary counting avoids creating breakdown records and does not use generators.

To measure speed against gpt-tokenizer and ai-tokenizer, run `pnpm benchmark`.

## API

### `estimateTokenCount`

Estimates the number of tokens in a given input string using heuristic rules that work across multiple languages and text types.

**Usage:**

```ts
const estimatedTokens = estimateTokenCount('Hello, world!')

// With custom options
const customEstimate = estimateTokenCount('Bonjour le monde!', {
  defaultCharsPerToken: 4,
  languageConfigs: [
    { pattern: /[éèêëàâîï]/i, averageCharsPerToken: 3 }
  ]
})
```

**Type Declaration:**

```ts
function estimateTokenCount(
  text?: string,
  options?: TokenEstimationOptions
): number

interface TokenEstimationOptions {
  /** Predefined model ID or custom profile; omitted profiles use the defaults. */
  profile?: ModelId | ModelProfile
  /** Text ratios; each overrides the profile's value. Defaults: `DEFAULT_TEXT_PROFILE`. */
  defaultCharsPerToken?: number
  punctuationCharsPerToken?: number
  digitsPerToken?: number
  shortTokenThreshold?: number
  lowercaseWordMaxLength?: number
  hanziCharsPerToken?: number
  kanaCharsPerToken?: number
  hangulCharsPerToken?: number
  languageCharsPerToken?: Partial<Record<LanguageId, number>>
  /** Custom language configurations; they replace the built-in language rules. */
  languageConfigs?: LanguageConfig[]
  /** Reuse estimates of repeated words between calls (default: true). */
  cache?: boolean
}

interface LanguageConfig {
  /** Regular expression to detect the language. */
  pattern: RegExp
  averageCharsPerToken: number
}
```

### `isWithinTokenLimit`

Checks if the estimated token count of the input is within a specified token limit.

**Usage:**

```ts
const withinLimit = isWithinTokenLimit('Check this text against a limit', 100)
// With custom options
const customCheck = isWithinTokenLimit('Text', 50, { defaultCharsPerToken: 3 })
```

**Type Declaration:**

```ts
function isWithinTokenLimit(
  text: string,
  tokenLimit: number,
  options?: TokenEstimationOptions
): boolean
```

### `sliceByTokens`

Extracts a portion of text based on token positions, similar to `Array.prototype.slice()`. Supports both positive and negative indices.

**Usage:**

```ts
const text = 'Hello, world! This is a test sentence.'

const firstThree = sliceByTokens(text, 0, 3)
const fromSecond = sliceByTokens(text, 2)
const lastTwo = sliceByTokens(text, -2)
const middle = sliceByTokens(text, 1, -1)
```

**Type Declaration:**

```ts
function sliceByTokens(
  text: string,
  start?: number,
  end?: number,
  options?: TokenEstimationOptions
): string
```

**Parameters:**

- `text` - The input text to slice
- `start` - The start token index (inclusive). If negative, treated as offset from end. Default: `0`
- `end` - The end token index (exclusive). If negative, treated as offset from end. If omitted, slices to the end
- `options` - Token estimation options (same as `estimateTokenCount`)

**Returns:**

The sliced text portion corresponding to the specified token range.

### `splitByTokens`

Splits text into chunks based on token count. Useful for chunking documents for RAG, batch processing, or staying within context windows.

`tokensPerChunk` is a target, not a hard maximum: a chunk closes once it reaches the target, so a single long segment can push a chunk beyond it. Chunks never break words apart. Segments split on whitespace and punctuation, so for CJK text – where a whole clause between two punctuation marks is a single segment – chunks can far exceed the target.

**Usage:**

```ts
const text = 'Long text that needs to be split into smaller chunks...'

// Basic splitting
const chunks = splitByTokens(text, 100)
console.log(`Split into ${chunks.length} chunks`)

// With overlap for semantic continuity
const overlappedChunks = splitByTokens(text, 100, { overlap: 10 })

// With custom options
const customChunks = splitByTokens(text, 50, {
  defaultCharsPerToken: 4,
  overlap: 5
})
```

**Type Declaration:**

```ts
interface SplitByTokensOptions extends TokenEstimationOptions {
  /** Number of tokens to overlap between consecutive chunks (default: 0, clamped below `tokensPerChunk`). */
  overlap?: number
}

function splitByTokens(
  text: string,
  tokensPerChunk: number,
  options?: SplitByTokensOptions
): string[]
```

**Parameters:**

- `text` - The input text to split
- `tokensPerChunk` - Target number of tokens per chunk
- `options` - Token estimation options with optional overlap

**Returns:**

An array of text chunks, each containing approximately `tokensPerChunk` tokens. With `overlap`, each chunk repeats the trailing tokens of the previous one; a final chunk consisting only of overlap content is never emitted.

## License

[MIT](https://github.com/isaacwasserman/tokenx/blob/main/LICENSE). Copyright (c) 2023-PRESENT Johann Schopplich, and 2026-PRESENT Isaac Wasserman for this fork.
