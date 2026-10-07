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

`pnpm benchmark` compares the estimates with OpenAI's `o200k_base` counts on the sample corpus and prints a chart of each sample's deviation, then times tokenx against gpt-tokenizer and ai-tokenizer; the mean deviation is about 3.7%, and every sample stays within ±10%.

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

# Count with a model's tuned text rules
tokenx prompt.txt --profile anthropic/claude-sonnet-5.5

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

All `ModelProfile` fields are optional and JSON-safe. `resolveProfile(profile)` fills missing fields from `DEFAULT_PROFILE` and missing text rules from `DEFAULT_TEXT_PROFILE`; `estimator.profile` exposes the resolved values. The defaults are model-neutral: the o200k text rules of plain tokenx and approximate request overhead. The example above illustrates custom values; it is not a calibrated profile for a specific model. Automatic tuning is available through `tokenx/tune`.

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
| `perAdditionalPropertiesTrue` | 0 | Each `additionalProperties: true`, in addition to `perAdditionalProperties` |
| `perInteger` / `perBoolean` | 0 / 0 | Each schema node with an integer / boolean type |
| `perArrayOfPrimitives` | 0 | Each primitive array item schema, including union branches |
| `perNestedObject` / `perArrayOfObjects` | -3 / 1 | Object properties / object array items |
| `perToolCall` / `perToolResult` | 0 / 0 | Each call / result part |
| `perImage` / `perFile` | 85 / 100 | Each image / file part |
| `perReasoning` | 0 | Each reasoning part without an encrypted payload, plus its text |
| `perReasoningPayloadChar` | 0.43 | Each character of an encrypted reasoning payload after its envelope; the summary text is not counted |
| `reasoningPayloadEnvelopeChars` | 0 | Characters at the start of each payload that cost nothing (the encryption envelope) |
| `countReasoningInPreviousTurns` | `true` | Whether encrypted reasoning before the last user message is counted; `false` for models that drop it |

Image and file costs are fixed estimates independent of dimensions, file length or binary data. Generic file parts with an image media type, including AI SDK v7 `mediaType: 'image'`, use `perImage`. Inline file text supported by the SDK is counted as text in addition to the file cost. Set these costs to fit your model and typical media inputs.

The seven additional schema weights default to zero. Required names now contribute text even with zero weights; retune existing profiles that were calibrated with required schemas. Controlled probes distinguish list framing from per-entry costs, enum framing from cardinality, keyword presence from omission, and scalar array items from object items.

### Predefined profiles

The [profile registry](src/profiles.json) includes calibrated `anthropic/claude-opus-5.5`, `anthropic/claude-sonnet-4.5`, `anthropic/claude-sonnet-5.5`, `openai/gpt-5.1`, and `openai/gpt-6.1-sol` profiles, keyed as `provider/model` in OpenRouter's naming. The OpenAI profiles use the default text rules with their own measured overheads. Add a model with `pnpm tune` (see [Tune a model profile](#tune-a-model-profile)). `ModelId` is derived from its keys, so TypeScript accepts only model IDs with a predefined profile.

```ts
import { createUsageEstimator, estimateTokenCount, estimateUsage, MODEL_PROFILES } from 'tokenx'

const estimator = createUsageEstimator('anthropic/claude-sonnet-5.5')
const tokens = estimateUsage(input, { profile: 'anthropic/claude-sonnet-5.5' })
const textTokens = estimateTokenCount('Hello world', { profile: 'anthropic/claude-sonnet-5.5' })
const profile = MODEL_PROFILES['anthropic/claude-sonnet-5.5']
```

Omit `profile` to use the existing defaults. Custom profile objects are also accepted. The text APIs use text rules and a multiplier without request overhead; direct text options override the profile's ratios. `sliceByTokens`, `splitByTokens`, and `isWithinTokenLimit` accept the same `profile` option. Shared predefined profiles are immutable. Unsupported model IDs throw for JavaScript callers.

#### Reasoning

Anthropic returns thinking as a visible summary (or nothing) plus an encrypted `signature`; redacted thinking has only `redactedData`. OpenAI returns reasoning summaries plus `reasoningEncryptedContent` when requested with `store: false`. Through OpenRouter, the AI SDK provider keeps these payloads in `providerOptions.openrouter.reasoning_details`. When the history is sent back, the provider decrypts the payload; Anthropic's measured counts show that it charges the hidden thinking, not the summary. A reasoning payload in `providerOptions.anthropic`, `providerOptions.openai`, or `providerOptions.openrouter` therefore costs `perReasoningPayloadChar × (payload length − reasoningPayloadEnvelopeChars)`, and its summary text is not counted. The envelope is the part of every payload that holds no thinking: encryption header, nonce, tag, and metadata. Reasoning before the last user message belongs to a previous turn. Some models count it at the same cost (`countReasoningInPreviousTurns: true`: Claude Sonnet 5.5, GPT-6.1 Sol); others drop it, so it costs nothing (`false`: Claude Sonnet 4.5, GPT-5.1). Reasoning in the current turn, such as before a tool call, is always counted. The AI SDK splits an OpenAI reasoning item into one part per summary, so parts with the same `itemId` are charged once. Other reasoning parts cost `perReasoning` plus their text; stored OpenAI items (sent as references, without a payload) fall in this group and are underestimated. The defaults are an upper bound of the measured models, so a request without a profile overestimates reasoning; each predefined profile has its own costs.

The costs do not depend on the reasoning level: every level of a model uses the same encryption, and per-level fits differed no more than two samples of one level. A level at which the model does not reason produces no payloads. Display mode (summarized or omitted) showed no bias. See [reasoning calibration](#reasoning-payloads) for accuracy and limits.

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

## Tune a model profile

Import `tuneProfile` from `tokenx/tune`, and a provider adapter from `tokenx/provider-adapters`. An adapter is how the tuner reaches a model:

```ts
interface ProviderAdapter {
  countTokens: GroundTruthCounter // the provider's input-token count for a request
  invokeModel?: ModelInvoker // response messages, for reasoning calibration
  supportsInput?: (input: UsageInput) => boolean // probes the provider rejects are skipped
}
```

`createProviderAdapter('anthropic' | 'openai' | 'openrouter', { apiKey, modelId, reasoningLevel? })` returns one; `reasoningLevel` is the effort of its generated responses, sent as each provider's effort setting, and without it the model uses its default; any object of this shape works. The tuner makes no provider requests itself and has no optimizer dependency.

```ts
import { createProviderAdapter } from 'tokenx/provider-adapters'
import { tuneProfile } from 'tokenx/tune'

const adapter = createProviderAdapter('openai', { apiKey, modelId: 'gpt-6.1-sol' })
const { profile, report } = await tuneProfile({ ...adapter, concurrency: 16 })
```

The result is a complete profile, ready for `createUsageEstimator` and for `src/profiles.json`. Without `invokeModel`, or when the model did not reason, the reasoning costs keep their initial values.

The tuner always uses its built-in inputs: controlled probes, natural text samples, separate selection documents, and validation requests, built from the excerpts in `src/tune/corpus/` (sources and licenses in `NOTICE`). Validation requests only report errors; they never fit or select a profile.

| Option | Default | Purpose |
| --- | --- | --- |
| `countTokens` | Required | Return a finite nonnegative ground-truth input count, or `{ count, usage }` when counting is billed |
| `supportsInput` | None | Skip probes and validation requests the provider rejects |
| `invokeModel` | None | Return the model's response messages, or `{ messages, usage }` with the billed tokens; when given, the tuner also fits reasoning costs (at most 10 calls, usually paid) |
| `initial` | `DEFAULT_PROFILE` | Starting profile; unmeasurable fields retain these values |
| `concurrency` | `4` | Maximum simultaneous counter calls and model calls |
| `onProgress` | None | Collection counts, model calls, and fitting events |
| `signal` | None | Abort collection or calibration |

### Calibration

1. **Text.** One-character word anchors identify the multiplier and single-message intercept. Labeled contrasts then measure individual ratios and gates, except the German, Romance, and Slavic Latin accent rules: they price a whole language through its accented words, so their ratios are fitted only on running text, including authored paragraphs in French, Spanish, Polish, Czech, Russian, and Greek; punctuation and the short-segment gate are measured together. Optional natural-text samples refine composition with the scale locked. The search considers the thresholds at which `ceil(length / ratio)` changes, including offsets for mixed CJK text, and integer values for gates. It searches one field at a time over four rounds. Separate selection documents choose among the initial text rules, the probe calibration, and each round; otherwise training loss chooses. Ratios stay at or above 1 / (UTF-8 bytes per character): 1 for ASCII and accented Latin words, 1/2 for Cyrillic and Greek, 1/3 for CJK, and 1/4 for emoji. Context contrasts diagnose boundary effects without fitting parameters.
2. **Overhead.** Each distinct text fragment in the overhead probes is counted directly during the text phase, with the measured intercept subtracted. Controlled request differences then identify structural coefficients using a rank-revealing QR solve, with the entire text profile locked. This prevents heuristic text errors from being absorbed into overhead weights.

Default probe lengths are 128, 512, and 2,048 code points. Probes the provider rejects (`supportsInput`) are skipped. Providers requiring complete tool exchanges cannot identify call and result overhead separately; one coefficient retains its initial value.

Shared controls are counted once within a tuning run. Plain single-user requests share observations by their text; structured controls share their request object. Subsequent runs collect fresh counts. There are no persistent caches, hashes, or namespaces.


Counter errors propagate and stop scheduling new requests. Cancellation rejects promptly; pass the same signal to the provider client to cancel requests in flight. `onProgress` reports `stage: 'text' | 'overhead' | 'validation'` with `phase: 'collect'`, or a text/overhead `phase: 'fit'` event.

### Reports

`TuneReport` contains `counterCalls`, `timing`, `text`, `overhead`, `validation`, and final field diagnostics. `timing` lists each phase and each counter and model call, with times in milliseconds from the start of the run and the billed tokens that the counter or model reported. Text reports include the multiplier, nuisance intercept, anchor RMSE and R², per-rule residuals, natural-text refinement, and context residuals. Absent or collinear structural fields retain their initial values. Text-field identifiability means a probe responds to that field; equivalent ratio plateaus can remain.

Common error metrics report count, mean absolute token error (`mae`), mean squared relative error (`loss`), mean absolute percentage error (`mape`), signed mean percentage error, maximum absolute percentage error, and signed aggregate percentage error. Relative errors use a denominator of at least one; empty samples return zeros.

`report.overhead.contrasts` instead reports structural RMSE and maximum error **in tokens**, plus the fraction reproduced within numerical tolerance. Its directly measured text costs differ from the heuristic text estimates used by whole-request metrics. Exact contrasts therefore do not imply exact total token counts. Tokenization can vary with formatting, and schema features missing from the tally remain unmodeled.

### Adding a model: `pnpm tune`

```sh
pnpm tune --provider <anthropic|openai|openrouter> --model <id> [--write] [--profile]
```

The command calls `tuneProfile` with the provider adapter and prints the registry entry. With `--write`, it adds or replaces the entry in `src/profiles.json`. API keys come from `.env` (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`).

- **Key:** `provider/model`, with dated snapshot suffixes removed and version separators written as dots (`anthropic/claude-sonnet-4-5` becomes `anthropic/claude-sonnet-4.5`). OpenRouter model IDs are already keys.
- **Entry:** the tuned profile. It has no `text` when the default text rules predicted the selection documents better than the tuned ones.
- **Reasoning:** at most 10 billed model calls. The costs do not depend on the reasoning level, so the command generates at `high` effort to make sure the model reasons. A model that OpenRouter's public model list shows without effort levels, such as Claude Sonnet 4.5, has no effort to set: the command tunes its text and overhead costs and keeps the reasoning costs it already has. Each response is capped at 4,096 output tokens, thinking included; in saved Claude Opus 5.5 runs at medium effort, the longest response used 1,193. A run in which the model did not reason fails.
- **Profile:** with `--profile`, the command prints the time, calls, billed tokens, and cost of each phase from `report.timing`, at the list prices in OpenRouter's public model list. A failed run prints no profile.
- **Costs:** Anthropic and OpenAI count with free endpoints. OpenRouter has no counting endpoint, so its adapter counts with 1-token generations, and each count bills its prompt.
- **Files:** the command writes nothing except `src/profiles.json` with `--write`. Generated responses are not saved, so a rerun generates them again.


#### Adapters

- **Anthropic** counts with CountTokens and generates with the Messages API, keeping signed and redacted thinking blocks. Without a level, it sends no thinking settings, so the model uses its defaults.
- **OpenAI** counts with `POST /v1/responses/input_tokens` and generates with the Responses API (`store: false`, `include: ['reasoning.encrypted_content']`), sending each reasoning item with its encrypted content.
- **OpenRouter** uses the AI SDK provider `@openrouter/ai-sdk-provider` (with `ai`, optional peer dependencies). It counts with a 1-token generation with reasoning disabled, falling back to 16 tokens or default reasoning when a model rejects that, and reads the reported prompt tokens, which are the upstream model's native count. Leading system messages are sent as AI SDK `instructions`; requests with a later system message are skipped.

Providers that require each tool call to be answered skip probes with unanswered calls, so call and result overheads are not separable; `perToolCall` holds their sum. Reasoning without an encrypted payload is skipped for Anthropic and OpenAI, which reject it.

### Reasoning payloads

The input-token model for reasoning is:

```text
reasoning part with an encrypted payload = perReasoningPayloadChar * (payload length - reasoningPayloadEnvelopeChars)
                                          (0 before the last user message when countReasoningInPreviousTurns is false)
other reasoning part                     = perReasoning + its text
```

The estimator reads the payloads where each provider's AI SDK integration stores them: the Anthropic `signature` or `redactedData`; OpenAI `reasoningEncryptedContent`, once per reasoning item; and OpenRouter `reasoning_details` (encrypted `data` or a text detail's `signature`), from the message, its first tool call, or its first reasoning part, with unsigned Anthropic and Gemini text details dropped and duplicates sent once, as `@openrouter/ai-sdk-provider` sends them. Its visible summary is not counted. Paired counts show why: removing a thinking block removes the hidden thinking, and the summary added no information to the fit. The configuration does not change counts: the same history gives the same CountTokens result with any effort and display setting, or with none.

Real signatures come only from model responses, so these fields need `invokeModel`. When it is given, `tuneProfile` first completes the free text and overhead phases. Then it runs built-in conversations: 4 text prompts, of which two get a second response after a follow-up message, and 2 tool-use prompts that need reasoning before the tool call, where the tuner answers the call with a fixed result and asks for the final answer. That is at most 10 model calls. There are no validation generations: they only reported error, and each costs a paid call. Each history after a response is a sample: histories that end with a follow-up message measure earlier-turn reasoning, and histories that end with a tool result measure current-turn reasoning. The callback receives a history that ends with a user message or a tool result, plus the abort signal, and returns the response messages in AI SDK form, including tool calls, or `null` to end that conversation (for example after an incomplete response). Pass `input.tools` to the model. Enable thinking in the model call. A model error stops tuning.

```ts
import { generateText } from 'ai'
import { tuneProfile } from 'tokenx/tune'

const { profile, report } = await tuneProfile({
  countTokens,
  invokeModel: async (input, { signal }) => (await generateText({ model, ...input, abortSignal: signal, providerOptions })).response.messages,
})
```

The callback chooses the reasoning level; make sure the model reasons at it. The costs belong to the model, not to the level: every level uses the same encryption, and on 60 saved Claude Opus 5.5 histories at one level, fits on separate halves differed as much as the earlier per-level fits did.

Model calls usually consume credits. `report.reasoning.histories` returns the generated histories, so they can be saved and refit later without new model calls. Without `invokeModel`, `report.reasoning` is `null`. If the histories cannot identify the costs, for example because the model did not reason, the costs keep their initial values and `report.reasoning.reason` gives `absent`, `collinear`, or `invalid`.

The tuner counts each history twice: as given and without its payload reasoning parts. A message left empty is removed, and its locked cost is subtracted. It fits a per-block and a per-character cost twice: once with previous-turn reasoning at the same cost as current-turn reasoning, and once with previous-turn reasoning at zero, and keeps the case with the lower training loss as `countReasoningInPreviousTurns`. The per-block cost is negative, because each payload has a fixed envelope that holds no thinking; it is stored as the envelope length, `reasoningPayloadEnvelopeChars = −(per-block cost) / perReasoningPayloadChar`. `report.reasoning.turns` gives the number of histories with reasoning in each turn; the choice is measured only when both are present. The difference isolates the hidden cost, so text and structural errors cannot enter the two coefficients. A weighted least-squares solve minimizes relative error, so long histories do not dominate. Text rules and every other field stay locked. `report.reasoning.metrics` gives the error of the hidden cost alone (`reasoning`) and of complete requests (`request`) on the generated histories, before and after the fit.

### Measured profiles

Measured on 2026-10-06. Text rules and overheads come from free counting. Reasoning costs come from generated histories, including tool-use loops, counted with and without their payloads. A model counts previous-turn reasoning either at exactly the same cost as in the current turn or not at all; the same block, counted in both positions, confirmed this for every block measured.

| Model | Text rules | `perReasoningPayloadChar` / `reasoningPayloadEnvelopeChars` | `countReasoningInPreviousTurns` |
| --- | --- | --- | --- |
| `anthropic/claude-opus-5.5` | tuned | 0.2961 / 707.6 | `true` |
| `anthropic/claude-sonnet-4.5` | tuned | 0.4262 / 523.2 | `false` |
| `anthropic/claude-sonnet-5.5` | tuned | 0.2727 / 600.7446 | `true` |
| `openai/gpt-5.1` | defaults | 0.2196 / 1209.6 | `false` |
| `openai/gpt-6.1-sol` | defaults | 0.1641 / 1121.3 | `true` |

The reasoning costs were measured per level before they became one value per model. Claude Sonnet 5.5 was retuned on 2026-10-07 with `pnpm tune` (10 generations at high effort, accent ratios fitted on running text); GPT-6.1 Sol uses its fit over the histories of all levels; GPT-5.1 uses the mean of its low, medium and high fits; Claude Sonnet 4.5 uses its only level, a 4,096-token thinking budget; Claude Opus 5.5 uses all 60 saved histories at medium.

The OpenAI profiles use the default text rules: they were calibrated against o200k and generalized better than a tuned set. Every Sonnet 5.5 overhead contrast is reproduced exactly and every Sonnet 4.5 contrast within 1 token; OpenAI schemas still differ by up to 4 tokens per contrast on property descriptions, nested objects, required lists, and tool exchanges.

#### Holdout

The profiles were frozen, then evaluated once on data that no tuning or profile choice used: 12 new documents (Wikipedia articles in 8 languages, Python and Rust source, a GitHub API response, a README) at two lengths in three request shapes, 18 new tool requests, and new reasoning conversations at every supported level. These results were measured with the earlier per-level reasoning costs. Mean absolute error / aggregate error against each provider's count:

| Request set | Model | tokenx 2.1.0 | ai-tokenizer 1.0.7 | This profile |
| --- | --- | ---: | ---: | ---: |
| Documents and chat (72) | Claude Sonnet 4.5 | 45.6% / −47.1% | 10.5% / +7.2% | 6.7% / +2.3% |
| Tool definitions and calls (18) | Claude Sonnet 4.5 | 67.6% / −65.0% | 22.0% / −23.4% | 2.2% / −1.7% |
| Reasoning histories (13) | Claude Sonnet 4.5 | 80.4% / +25.1% | 5.7% / −5.9% | 8.0% / +6.4% |
| Documents and chat (72) | GPT-5.1 | 5.0% / −1.9% | 8.0% / +5.4% | 5.0% / −0.7% |
| Tool definitions and calls (18) | GPT-5.1 | 28.3% / +27.3% | 41.3% / −18.7% | 4.0% / +1.9% |
| Reasoning histories (39) | GPT-5.1 | 63.4% / +60.5% | 6.4% / +3.9% | 7.6% / −8.2% |
| Documents and chat (72) | Claude Sonnet 5.5 | 49.0% / −47.1% | 14.8% / +7.2% * | 6.8% / +2.9% |
| Tool definitions and calls (18) | Claude Sonnet 5.5 | 66.2% / −63.5% | 25.8% / −20.0% * | 3.1% / −1.4% |
| Reasoning histories (65) | Claude Sonnet 5.5 | 53.4% / −68.9% | 36.2% / −70.9% * | 4.8% / +0.3% |
| Documents and chat (72) | GPT-6.1 Sol | 5.1% / −2.0% | 7.7% / +5.2% * | 5.0% / −0.7% |
| Tool definitions and calls (18) | GPT-6.1 Sol | 27.9% / +26.7% | 41.3% / −19.1% * | 4.0% / +1.9% |
| Reasoning histories (65) | GPT-6.1 Sol | 26.1% / −41.8% | 42.5% / −57.8% * | 7.6% / −9.8% |

\* ai-tokenizer has no entry for the model; its Claude Sonnet 4.5 or GPT-5.1 Thinking entry is used. tokenx 2.1.0 counts text only, with tool definitions serialized as JSON.

Stored OpenAI reasoning items (the AI SDK default `store: true`) are sent as references without a payload and are underestimated.

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

[MIT](./LICENSE) License © 2023-PRESENT [Johann Schopplich](https://github.com/johannschopplich)
