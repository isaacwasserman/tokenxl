# @tokenxl/tune

Tunes [`@tokenxl/count`](https://github.com/isaacwasserman/tokenx/tree/main/packages/count) model profiles against a provider's input-token counts: text rules, request and tool overhead, images, and encrypted and stored reasoning.

```bash
pnpm add @tokenxl/count @tokenxl/tune
```

The provider adapters need the AI SDK (`ai` 7) and the provider package: `@ai-sdk/anthropic`, `@ai-sdk/openai`, or `@openrouter/ai-sdk-provider`.

## Tune a model profile

```sh
pnpm tune --provider <anthropic|openai|openrouter> --model <id> [--write] [--profile] [--no-reasoning]
```

`pnpm tune` measures a model and prints its entry for `packages/count/src/profiles.json`; `--write` adds or replaces it there, `--profile` prints the time and cost of each phase, and `--no-reasoning` generates nothing and keeps the reasoning costs the entry already has. Run it from the repository root. API keys come from `.env` at the root (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`).

- **What it measures:** text rules and request overhead from token counts, which are free on Anthropic and OpenAI; OpenRouter has no count endpoint, so each count is a billed 1-token generation. Reasoning costs come from at most 10 generations at `high` effort, each capped at 4,096 output tokens (about $0.05–0.15 per run). A model without effort levels, such as Claude Sonnet 4.5, keeps the reasoning costs it already has.
- **Key:** `provider/model`, with dated snapshot suffixes removed and version separators written as dots (`claude-sonnet-4-5-20250929` becomes `anthropic/claude-sonnet-4.5`).
- **Images:** controlled probes with images of several sizes and aspect ratios measure `perImage`, `perImagePatch`, `perToolResultImage`, and choose `imagePatchSize` from 14, 16, 28, 32 and 512 pixels. The probes are smaller than every measured resize limit, so the limits (`imageMaxEdge`, `imageMaxShortEdge`, `imageMaxPatches`) come from `initial` or the provider's documentation.
- **Entry:** the tuned profile, without `text` when the default text rules predicted held-out documents better than the tuned ones.

The same tuner is a library. Pass a profile it returns to any `@tokenxl/count` API:

```ts
import { createProviderAdapter } from '@tokenxl/tune/provider-adapters'
import { tuneProfile } from '@tokenxl/tune'

const adapter = createProviderAdapter('openai', { apiKey, modelId: 'gpt-6.1-sol', reasoningLevel: 'high' })
const { profile, report } = await tuneProfile({ ...adapter, concurrency: 16 })
```

An adapter is any `{ countTokens, invokeModel?, supportsInput? }`: `countTokens` returns the provider's input-token count (or `{ count, usage }` when counting is billed), `invokeModel` returns the response messages in AI SDK form (or `{ messages, usage }`), and `supportsInput` skips requests the provider rejects. Without `invokeModel`, reasoning costs keep their initial values. Other options: `initial` (default `DEFAULT_PROFILE`), `concurrency` (default 4), `onProgress`, and `signal`. `report` holds the fit diagnostics, validation errors, and the time and billed tokens of every phase and call.

The built-in adapters use the AI SDK: Anthropic and OpenAI through `@ai-sdk/anthropic` and `@ai-sdk/openai`, which count by sending the exact request body the package builds to the free count endpoint, and OpenRouter through `@openrouter/ai-sdk-provider`. Each is an optional peer dependency, with `ai` 7.

## Measured profiles

| Model | Text rules | `perReasoningPayloadChar` / `reasoningPayloadEnvelopeChars` | `countReasoningInPreviousTurns` |
| --- | --- | --- | --- |
| `anthropic/claude-opus-5.5` | tuned | 0.2961 / 707.6 | `true` |
| `anthropic/claude-sonnet-4.5` | tuned | 0.4262 / 523.2 | `false` |
| `anthropic/claude-sonnet-5.5` | tuned | 0.2727 / 600.7446 | `true` |
| `openai/gpt-5.1` | defaults | 0.2196 / 1209.6 | `false` |
| `openai/gpt-6.1-sol` | defaults | 0.1641 / 1121.3 | `true` |

All five profiles were retuned on 2026-10-08 with `pnpm tune --no-reasoning`, so their text rules, overheads and image costs come from the current tuner and their reasoning costs are unchanged. The reasoning costs were measured per level before they became one value per model: Claude Sonnet 5.5 was tuned on 2026-10-07 at high effort, GPT-6.1 Sol uses its fit over all levels, GPT-5.1 the mean of its low, medium and high fits, Claude Sonnet 4.5 its 4,096-token thinking budget, and Claude Opus 5.5 all 60 saved histories at medium. The stored-reasoning costs of the OpenAI profiles (GPT-6.1 Sol 173 / 1.38, GPT-5.1 118 / 2.3) come from 150 stored items at all levels, and the image resize limits from 1,237 measured images. The OpenAI profiles keep the default text rules, which generalized better than a tuned set.

The 2026-10-08 retune against the earlier profiles, on the request holdout below (mean absolute error / aggregate error). These requests also guided changes to the tuner, so they are no longer a clean holdout:

| Request set | Model | Before | After |
| --- | --- | ---: | ---: |
| Documents and chat (72) | Claude Sonnet 5.5 | 4.5% / +2.4% | 4.0% / +3.1% |
| Tool definitions and calls (18) | Claude Sonnet 5.5 | 3.2% / −0.5% | 3.0% / +1.9% |
| Documents and chat (72) | Claude Opus 5.5 | 6.3% / +2.2% | 4.0% / +3.1% |
| Tool definitions and calls (18) | Claude Opus 5.5 | 3.3% / −1.7% | 3.0% / +1.9% |
| Documents and chat (72) | Claude Sonnet 4.5 | 6.7% / +2.3% | 3.7% / +2.3% |
| Tool definitions and calls (18) | Claude Sonnet 4.5 | 2.2% / −1.7% | 1.4% / +0.6% |
| Documents and chat (72) | GPT-6.1 Sol, GPT-5.1 | 5.0% / −0.7% | 4.6% / −1.3% |
| Tool definitions and calls (18) | GPT-6.1 Sol, GPT-5.1 | 4.0% / +1.9% | 2.3% / +2.0% |

The earlier profiles on the full holdout, measured once before any tuning used it, with the earlier per-level reasoning costs (mean absolute error / aggregate error against each provider's count):

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


## Tuning method

See [CONTEXT.md](https://github.com/isaacwasserman/tokenx/blob/main/CONTEXT.md#tuning-method) for the staged calibration.

## License

[MIT](https://github.com/isaacwasserman/tokenx/blob/main/LICENSE). The tuning corpus keeps the licenses listed in [NOTICE](https://github.com/isaacwasserman/tokenx/blob/main/packages/tune/NOTICE).
