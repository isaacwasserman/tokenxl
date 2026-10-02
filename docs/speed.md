# Speed measurements

Measured locally on macOS with Node v24.19.0, Vitest 4.1.10, ai-tokenizer 1.0.7, and gpt-tokenizer 3.4.0. These are timing samples, not portable performance guarantees.

## Text API comparison with the original implementation

The baseline source files were saved before editing and verified to match `origin/main`. Both implementations counted the same current corpus (153,447 UTF-16 code units), consisting of the benchmark fixtures and the source-code sample used by the existing accuracy suite. Each case ran for three seconds.

| Operation | Original mean | Current mean | Speedup |
| --- | ---: | ---: | ---: |
| `estimateTokenCount` | 6.4720 ms | 1.3222 ms | 4.89× |
| `splitByTokens` (500-token chunks) | 7.0353 ms | 2.8715 ms | 2.45× |

The original pre-edit text benchmark also recorded 6.2814 ms for `estimateTokenCount`, 14.5842 ms for gpt-tokenizer, and 9.8670 ms for ai-tokenizer. The source-code sample changed as implementation proceeded, so the same-corpus comparison above is the direct regression check.

A seeded differential check on 60,014 inputs and five option sets found zero changes to counting, slicing, or overlapping splitting relative to the original implementation. The existing accuracy, holdout, and heuristic tests pass without updating their assertions or snapshots.

## Request estimation

The fixture contains 50 model messages and 10 tools, including calls, JSON results, nested objects and arrays. The estimator uses the structural weights from ai-tokenizer's `anthropic/claude-sonnet-4.5` profile. Each benchmark ran for two seconds.

| Operation | Mean | Relative to reused tokenx estimator |
| --- | ---: | ---: |
| tokenx `count` | 0.0578 ms | 1× |
| tokenx `count` with breakdown | 0.0632 ms | 1.09× |
| tokenx `count`, new estimator | 0.3826 ms | 6.62× |
| ai-tokenizer SDK `count` | 1.1542 ms | 19.97× |

A preceding run measured 21.34× faster counting and 1.26× breakdown overhead. Both runs meet the 10× reused-estimator speed target and approximately 1.3× breakdown-overhead target. A fresh estimator was about 3× faster than ai-tokenizer in the reported run.

All repeated cases use warmed caches. tokenx caches tool schemas and, per estimator, up to 256 text strings of at most 4,096 UTF-16 code units. Reusing conversation prefixes is the intended workload; a new estimator discards those request caches and walks every tool schema. The text engine also has a bounded cache for up to 8,192 slow-path segments. BPE tokenizers reuse their internal caches. The fresh-estimator case still benefits from the default text engine's shared segment cache.

| Text tokenizer on the same corpus | Mean |
| --- | ---: |
| tokenx `estimateTokenCount` | 1.4239 ms |
| gpt-tokenizer `o200k_base` encode | 15.6559 ms |
| ai-tokenizer Claude count | 10.4893 ms |

The request estimate was 10,353 tokens, identical with and without a breakdown. ai-tokenizer estimated 11,373 tokens (tokenx was 8.97% lower). This is a comparison between estimators, not a provider ground-truth measurement; schema coverage and text rules differ. No calibrated Anthropic profile or optimizer is shipped in this phase.

## Reproduce

Run `pnpm bench:speed` for the text and request benchmarks. It explicitly selects `bench/`, excluding local experiments under `.context/`.

To compare another checkout with its original implementation, preserve the original `src/index.ts`, `src/segments.ts`, and `src/types.ts` together, then import both versions in a Vitest benchmark that passes the same corpus to each.

Validation also included `pnpm test --run`, `pnpm test:types`, `pnpm lint`, and `pnpm build`. The usage API compile fixture and source were checked against AI SDK 5.0.271, 6.0.300, and 7.0.126; SDK 5 and 6 JSON Schema wrappers were also checked at runtime.
