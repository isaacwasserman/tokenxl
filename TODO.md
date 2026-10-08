# TODO

- [ ] Read the OpenAI image `detail` setting (`providerOptions.openai.imageDetail`). The estimates assume the default detail; `low` and `high` use other resize rules (measured in `.context/images/`).
- [ ] Model what is left of the OpenAI schema rendering: a nested object's first property costs less than a root property, required names are not rendered (the estimator counts them as text), number enums, `anyOf` branches that are objects or have descriptions, and description placement inside array items. An exact renderer is a possible next step (`.context/openai-schema/render.ts`).
- [ ] Let the tuner prefer tuned text rules for o200k-like tokenizers when they are better. On GPT-6.1 Sol the tuner keeps the o200k defaults, because its selection documents have no Russian; the defaults underestimate Russian Wikipedia text by 18%.
- [ ] Price literary French better. After the unaccented word scale, the Claude Sonnet 5.5 profile underestimates Candide by 10.8% (German −3.2%, English −3.5%, Russian +2.9%; check script `.context/language-holdout.ts`). Modern French is within 4%.
