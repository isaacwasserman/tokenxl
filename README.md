# tokenxl

Fast token estimation for LLM requests, without a tokenizer, and the tools to tune it for each model.

| Package | What it does |
| --- | --- |
| [`@tokenxl/count`](packages/count) | Estimates the tokens of text, AI SDK messages, tool schemas, images and reasoning, with predefined model profiles. Includes the `tokenxl` CLI. No runtime dependencies. |
| [`@tokenxl/tune`](packages/tune) | Measures a model through its provider's token counts and produces a model profile for `@tokenxl/count`. Includes provider adapters for Anthropic, OpenAI and OpenRouter. |

tokenxl is a fork of [tokenx](https://github.com/johannschopplich/tokenx) by Johann Schopplich. It adds model profiles for request overhead, a request estimator for the AI SDK, and the profile tuner.

## Development

```bash
pnpm install
pnpm test        # Both packages, against their sources
pnpm typecheck
pnpm lint
pnpm build
pnpm benchmark   # @tokenxl/count speed and accuracy
pnpm tune --provider anthropic --model claude-sonnet-5-5   # see packages/tune
```

In the workspace, `@tokenxl/tune` imports `@tokenxl/count` from its sources through the `tokenxl-source` export condition, so it needs no build first. The published packages use `dist`. `@tokenxl/tune` uses the internals of `@tokenxl/count` (`@tokenxl/count/internal`), so it depends on the exact same version. Release both packages together.

[CONTEXT.md](CONTEXT.md) defines the terms and the tuning method.

## License

[MIT](LICENSE)
