# tokenx

Fast and lightweight token count estimation without requiring a full tokenizer.

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

The following chart shows how close the estimates come to actual GPT token counts for different input texts:

<!-- automd:file src="./docs/bench.md" -->

Bars grow left when tokenx underestimates and right when it overestimates. The axis spans the ±10% per-sample deviation bound.

```
                                                          under ◂·▸ over
Team chat transcript (en)               293 →    285          ███│              -2.73%
Vite releases API response            8,075 →  8,551             │██████        +5.89%
tokenx source code                    3,151 →  3,050          ███│              -3.21%
Vite plugin API docs (en)             6,901 →  7,155             │████          +3.68%
Cat article (ja)                     12,437 → 11,529      ███████│              -7.30%
Cat article (ko)                      7,117 →  6,841         ████│              -3.88%
Cat article (zh)                      9,057 →  8,828          ███│              -2.53%
The Great Gatsby by Fitzgerald (en)   4,391 →  4,479             │██            +2.00%
Die Verwandlung by Kafka (de)         4,437 →  4,384            █│              -1.19%
                                                       ─────────────────────
                                                                        mean     3.60%
```

<!-- /automd -->

Accuracy depends on the kind of text, not its length: a short excerpt deviates about as much as the full document it came from. A holdout corpus that no ratio was ever fitted against is held to a looser ±15% bound, so a retune cannot silently overfit the chart.

Three cases are knowingly outside these bounds, all underestimates:

- **High-entropy strings** – base64, hashes, digests: ≈-70%. Pricing them would cost every caller runtime for a case ordinary traffic rarely carries.
- **Traditional and classical Chinese** – the hanzi rate is calibrated on contemporary simplified script: ≈-10% to -20%.
- **Scripts without a built-in rule** – Arabic ≈-35%, Hindi ≈-30%, Hebrew ≈-45%, Thai ≈-60%; a custom language rule closes the gap.

## Installation

```bash
# npm
npm install tokenx

# pnpm
pnpm add tokenx

# yarn
yarn add tokenx
```

## CLI

The package ships a `tokenx` binary – no install needed via `npx`, or install it for the commands below.

```bash
# Count tokens in a file, a pipe, or several files at once
tokenx README.md
cat article.md | tokenx
tokenx count src/*.ts

# Fail a script when a prompt outgrows its budget (exit code 2)
tokenx prompt.txt --limit 8000

# Extract a token range, or chunk a document for RAG
tokenx slice article.md --end 500
tokenx split article.md --size 500 --overlap 50
```

Only results go to stdout – counts as bare integers, chunks as a JSON array – so `$(tokenx count file.txt)` and `| jq` work unchanged. Notices and errors go to stderr. Run `tokenx --help` for every option.

## Usage

```ts
import { estimateTokenCount, isWithinTokenLimit, sliceByTokens, splitByTokens } from 'tokenx'

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

Use `createUsageEstimator` for repeated requests to one model. It accepts AI SDK v5–v7 `ModelMessage` arrays and `ToolSet` objects. Convert UI messages to model messages before estimating. The `ai` peer dependency is optional; plain-text callers do not need it, and tokenx never imports it at runtime.

```ts
import type { ModelMessage } from 'ai'
import { tool } from 'ai'
import { createUsageEstimator, estimateUsage } from 'tokenx'
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

All `ModelProfile` fields are optional and JSON-safe. `resolveProfile(profile)` fills missing fields from `DEFAULT_PROFILE`; `estimator.profile` exposes the resolved values. The defaults are approximate OpenAI-style request overhead, with text calibrated to o200k. The example above illustrates custom values; it is not a calibrated profile for a specific model. Automatic tuning is deferred.

The estimate is the sum of structural costs and `contentMultiplier × textTokens`, rounded once at the end. The multiplier applies to message text, tool names, descriptions, property names, enum values, and serialized tool-call inputs and JSON results. Each message adds `perMessage`, and system messages additionally add `perSystem`. Tool-call IDs are omitted; their average cost can be absorbed into `perToolCall` and `perToolResult`. Unknown message parts count zero and appear in the breakdown.

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
| `perNestedObject` / `perArrayOfObjects` | -3 / 1 | Object properties / object array items |
| `perToolCall` / `perToolResult` | 0 / 0 | Each call / result part |
| `perImage` / `perFile` | 85 / 100 | Each image / file part |
| `perReasoning` | 0 | Each reasoning part, plus its text |

Image and file costs are fixed estimates independent of dimensions, file length or binary data. Generic file parts with an image media type, including AI SDK v7 `mediaType: 'image'`, use `perImage`. Inline file text supported by the SDK is counted as text in addition to the file cost. Set these costs to fit your model and typical media inputs.

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
| `hanziCharsPerToken` / `kanaCharsPerToken` / `hangulCharsPerToken` | 1.15 / 1.4 / 1.65 |
| `languageCharsPerToken` | german: 3, romance: 4.5, slavicLatin: 2.5, cyrillic: 6, greek: 3, emoji: 0.9 |

Use positive, finite ratios and nonnegative integer thresholds. Custom `languageConfigs` on the text APIs replace the built-in language rules and take precedence over `languageCharsPerToken`. Profiles use the JSON-safe named language ratios.

### Schemas and caching

The estimator reads AI SDK `jsonSchema()` and `zodSchema()` wrappers, Standard JSON Schema (including Zod 4.2+), synchronous lazy schema functions, and plain JSON Schema objects. For other schema formats, pass a synchronous converter:

```ts
const estimator = createUsageEstimator(profile, {
  toJsonSchema: schema => convertToJsonSchema(schema),
})
```

Every schema source must resolve synchronously. A promise or thenable throws `TypeError`; resolve it before calling the estimator. Unsupported schemas count only the tool name and description unless a converter is provided. Local `$ref` values resolve at each use site, with recursive references stopped and a depth limit of 64. Unused definitions and external references are not expanded. Optional and nullable schemas, enums, arrays, and `anyOf` / `oneOf` / `allOf` branches are walked.

Reuse the estimator and tool objects to reuse cached schema costs. Each estimator also caches token estimates for up to 256 text strings of at most 4,096 UTF-16 code units; longer strings are scanned each time. Treat profile and tool objects as immutable once used; create a new estimator after changing a profile and replace a tool object after changing its schema. `estimateUsage` caches one estimator per profile object, and one for the defaults.

### Breakdown

`estimator.count(input, { breakdown: true })` and `estimateUsage(input, { breakdown: true })` return the same rounded `total` as ordinary counting, with:

- `baseOverhead` and `messages`, each with `role`, `total`, `overhead`, and `parts`.
- `tools.total`, `tools.overhead`, and `tools.definitions` keyed by tool name.
- Each definition's `name`, `description`, and `inputSchema` costs.
- Schema properties keyed by paths such as `filter.kind` and `rows[].id`, each with `name`, `overhead`, `description`, `enum`, `nested`, and `total`.

Component values retain fractions; only the request total is rounded. A parent property's `nested` includes its children's costs, so sum root properties only when reconciling a schema total. Repeated paths in union branches are aggregated. Cached tool breakdowns are copied on return so callers can safely modify the result. Ordinary counting avoids creating breakdown records and does not use generators.

Speed measurements and reproduction commands are in [docs/speed.md](docs/speed.md).

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
  /** Default average characters per token when no language-specific rule applies (default: 7). */
  defaultCharsPerToken?: number
  /** Custom language configurations to override defaults. */
  languageConfigs?: LanguageConfig[]
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

[MIT](./LICENSE) License © 2023-PRESENT [Johann Schopplich](https://github.com/johannschopplich)
