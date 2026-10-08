# tokenxl

[![@tokenxl/count](https://img.shields.io/npm/v/@tokenxl/count?label=%40tokenxl%2Fcount)](https://www.npmjs.com/package/@tokenxl/count)
[![@tokenxl/tune](https://img.shields.io/npm/v/@tokenxl/tune?label=%40tokenxl%2Ftune)](https://www.npmjs.com/package/@tokenxl/tune)

Count LLM tokens before you send the request. Text, messages, tools, images and reasoning, per model. No tokenizer, no network, no dependencies.

```ts
import { createUsageEstimator } from '@tokenxl/count'

const estimator = createUsageEstimator('anthropic/claude-sonnet-5.5')
estimator.count({ messages, tools }) // a request
estimator.count({ text }) // a text
```

## Why tokenxl

| | Accuracy | Speed | Offline | Whole requests |
| --- | --- | --- | --- | --- |
| Provider count API | Exact | ~500 ms | No | Yes |
| `gpt-tokenizer`, `tiktoken` | Exact for OpenAI text | ms | Yes | No |
| `ai-tokenizer` | 8–41% off | ms | Yes | Partly |
| `tokenx` | Good for OpenAI text | ms | Yes | No |
| **`@tokenxl/count`** | **2–5% off** | **µs** | **Yes** | **Yes** |

### Accuracy

Mean error against the provider's count, on 90 requests that no profile was tuned on:

| | Model | `tokenx` | `gpt-tokenizer` | `ai-tokenizer` | **`@tokenxl/count`** |
| --- | --- | ---: | ---: | ---: | ---: |
| Documents and chat | Claude Sonnet 5.5 | 49.0% | 49.1% | 14.8% | **4.0%** |
| Tools | Claude Sonnet 5.5 | 66.2% | 69.3% | 25.8% | **3.0%** |
| Documents and chat | GPT-6.1 Sol | 5.1% | **2.2%** | 7.7% | 4.6% |
| Tools | GPT-6.1 Sol | 27.9% | 20.2% | 41.3% | **2.3%** |

Tokenizers count text, not requests: they miss message framing, tool schemas and hidden reasoning.

### Speed

| | `@tokenxl/count` | `tokenx` | `gpt-tokenizer` | `ai-tokenizer` |
| --- | ---: | ---: | ---: | ---: |
| 143,588 characters | 1.3 ms | 6.1 ms | 14.8 ms | 10.3 ms |
| 50 messages, 10 tools | 0.06 ms | — | — | 0.98 ms |

## Install

```bash
npm install @tokenxl/count
```

## Usage

Make one estimator per model and reuse it. It caches tools and repeated text.

```ts
import { createUsageEstimator } from '@tokenxl/count'

const estimator = createUsageEstimator('openai/gpt-6.1-sol')
```

### Text

```ts
estimator.count({ text: 'Hello, world!' }) // 4
estimator.isWithinTokenLimit({ text: prompt }, 8000)
estimator.sliceByTokens(article, 0, 500)
estimator.splitByTokens(article, 1000, { overlap: 100 })
```

Text alone has no request overhead.

### Requests

Pass the same AI SDK messages and tools you give `generateText`.

```ts
import { tool } from 'ai'
import { z } from 'zod'

const tokens = estimator.count({
  messages: [
    { role: 'system', content: 'You are a travel assistant.' },
    { role: 'user', content: 'What is the weather in Boston?' },
  ],
  tools: {
    weather: tool({
      description: 'Get the weather for a city',
      inputSchema: z.object({ city: z.string() }),
    }),
  },
})
```

### Breakdown

```ts
const breakdown = estimator.count(input, { breakdown: true })
breakdown.messages // per message and part
breakdown.tools.definitions.weather // per tool and schema property
```

### Images and reasoning

Images are priced by their size. Encrypted reasoning is priced by its payload.

```ts
estimator.count({
  messages: [{
    role: 'user',
    content: [
      { type: 'text', text: 'What is in this picture?' },
      { type: 'image', image: pngBytes },
    ],
  }],
})
```

### CLI

```bash
npx @tokenxl/count README.md
cat article.md | npx @tokenxl/count
npx @tokenxl/count prompt.txt --limit 8000      # exits 2 when over
npx @tokenxl/count prompt.txt --profile anthropic/claude-sonnet-5.5
npx @tokenxl/count slice article.md --end 500
npx @tokenxl/count split article.md --size 500 --overlap 50
```

## Profiles

| Profile | Model |
| --- | --- |
| `anthropic/claude-opus-5.5` | Claude Opus 5.5 |
| `anthropic/claude-sonnet-5.5` | Claude Sonnet 5.5 |
| `anthropic/claude-sonnet-4.5` | Claude Sonnet 4.5 |
| `openai/gpt-6.1-sol` | GPT-6.1 Sol |
| `openai/gpt-5.1` | GPT-5.1 |

No profile? You get defaults calibrated for OpenAI's `o200k_base`.

## Make your own profile

[`@tokenxl/tune`](https://www.npmjs.com/package/@tokenxl/tune) measures any model on Anthropic, OpenAI or OpenRouter and returns a profile.

```bash
npm install @tokenxl/count @tokenxl/tune ai @ai-sdk/anthropic
```

```ts
import { createUsageEstimator } from '@tokenxl/count'
import { tuneProfile } from '@tokenxl/tune'
import { createProviderAdapter } from '@tokenxl/tune/provider-adapters'

const adapter = createProviderAdapter('anthropic', {
  apiKey: process.env.ANTHROPIC_API_KEY!,
  modelId: 'claude-haiku-4-5',
})
const { profile } = await tuneProfile(adapter)

createUsageEstimator(profile).count(input)
```

### Contribute it

```bash
pnpm install
pnpm tune --provider anthropic --model claude-haiku-4-5 --write
```

This adds the profile to [`profiles.json`](https://github.com/isaacwasserman/tokenxl/blob/main/packages/count/src/profiles.json). Open a pull request with it and a changeset (`pnpm changeset`).

## API

**`@tokenxl/count`**

| | |
| --- | --- |
| `createUsageEstimator(profile?, options?)` | An estimator for one model |
| `estimator.count(input)` | Tokens in a request (`{ messages, tools }`) or a text (`{ text }`) |
| `estimator.isWithinTokenLimit(input, limit)` | Whether a request or text fits |
| `estimator.sliceByTokens(text, start?, end?)` | A token range of a text |
| `estimator.splitByTokens(text, size, { overlap? })` | Chunks of a text |
| `MODEL_PROFILES` | The predefined profiles |

**`@tokenxl/tune`**

| | |
| --- | --- |
| `tuneProfile(options)` | A tuned profile and its report |
| `createProviderAdapter(provider, options)` | A counter for Anthropic, OpenAI or OpenRouter |

## Limitations

- Base64, hashes and IDs: up to 70% low.
- Arabic, Hebrew, Hindi, Thai: 30–60% low. Add a rule: `createUsageEstimator(profile, { languageConfigs })`.
- A profile fits one model.

## Development

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm benchmark
pnpm changeset
```

## License

[MIT](https://github.com/isaacwasserman/tokenxl/blob/main/LICENSE). Forked from [tokenx](https://github.com/johannschopplich/tokenx) by Johann Schopplich.
