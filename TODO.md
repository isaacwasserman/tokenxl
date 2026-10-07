# TODO

- [ ] Model image token costs using image dimensions. Separate fixed image framing overhead from visual tokens, account for provider resizing, and add controlled probes across sizes and aspect ratios. Retune the Sonnet 5.5 profile: its current `perImage: 4` was measured with a 1×1 PNG and underestimates larger images.
- [ ] Model OpenAI schema rendering exactly: `additionalProperties: true` (9 tokens on GPT-6.1 Sol, other values free), and the 1–2 token misses for property descriptions, nested objects, object arrays and tool exchanges.
- [ ] Improve text calibration for efficient tokenizers: on GPT-6.1 Sol the tuned text rules generalized worse than the o200k defaults.
- [ ] Estimate stored OpenAI reasoning items (`store: true`), which the AI SDK sends as references without encrypted content; their length is unknown, so they are underestimated.
- [ ] Price unaccented words in German and French text. On held-out text, the tuned Claude Sonnet 5.5 profile underestimates German by 10.8% and French by 13.6% (English 0.0%, Russian +3.1%): only about 10% of their words carry an accent, and the accent ratio cannot make up for the other words (German is at its floor of 1). A per-text language factor for unaccented Latin words, fitted on running text, could fix it; it changes the estimator, so check o200k accuracy too. Check script: `.context/language-holdout.ts`.
