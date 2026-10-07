# tokenx

Heuristic token count estimation for LLM text – trading a few percent of accuracy for near-zero bundle size, no tokenizer data files, and linear speed.

## Language

**Token**:
The unit of LLM text measurement that tokenx estimates. Calibrated against the reference tokenizer; every count is an estimate, never exact.
_Avoid_: word, character

**Reference tokenizer**:
The real tokenizer estimates are measured against – OpenAI's `o200k_base` encoding, used by all current OpenAI models (GPT-4o, o-series, GPT-5.x).
_Avoid_: cl100k_base (legacy), "the tokenizer"

**Segment**:
The atomic unit of estimation – a run of text (word, whitespace, or punctuation) that receives a token count as a whole and is never subdivided during counting.

**Deviation**:
The relative difference between an estimated count and the reference tokenizer's count for the same text. Positive when tokenx overestimates, negative when it underestimates.
_Avoid_: accuracy percentage, error rate

**Sample corpus**:
The fixed set of texts whose Deviation is measured against the reference tokenizer – the single source for both the published benchmarks and the enforced accuracy bounds.

**Heuristic bucket**:
A group of sentence- and paragraph-length inputs sharing one script or Register, recording where a rule's calibration currently sits.

**Holdout corpus**:
Texts deliberately kept out of every calibration decision, measured only to check that accuracy on the Sample corpus generalizes. Tuning anything against them retires them.
_Avoid_: validation set, test corpus

**Register**:
The variety of language a text is written in – everyday prose, technical documentation, machine-generated payload. Moves Deviation more than the script does.
_Avoid_: genre, domain, tone

**Language config**:
A rule pairing a script-detection pattern with that script's average characters per token. Custom configs take precedence over all built-in heuristics.
_Avoid_: locale, language pack

**Chunk**:
A contiguous piece of text produced by splitting, sized by estimated tokens and reconstructable in order.

**Target chunk size**:
The estimated token count at which a chunk closes. A soft threshold – a chunk may exceed it when a single segment crosses the boundary.
_Avoid_: maximum, limit

**Overlap**:
The trailing tokens of a chunk repeated at the start of the next chunk to preserve context across boundaries. Always smaller than the target chunk size, and never a chunk on its own.


**Model profile**:
JSON-safe text ratios and structural overhead weights for one model. Missing fields use `DEFAULT_PROFILE`; overhead values may be negative.
Schema weights distinguish enum cardinality, required-list framing and entries, explicit `additionalProperties`, integer/boolean types, and primitive array items. Required names contribute text independently of their overhead weights.

**Predefined profiles**:
The immutable registry in `src/profiles.json`, keyed as `provider/model` in OpenRouter's naming and read by `src/profiles.ts`. `ModelId` comes from the registry keys. `pnpm tune` adds or updates an entry through a provider adapter. Estimation APIs accept these IDs or custom profile objects; omitting a profile uses the existing defaults. Text APIs use the selected text rules and multiplier without structural overhead.

**Feature tally**:
The unweighted counts of request features and estimated text tokens produced by the usage walker. Its dot product with profile weights gives the unrounded estimate.

**Breakdown**:
An optional account of token costs by message, part, tool, and schema property. Component costs retain fractions; only the request total is rounded. Child properties are included in their parent's nested cost.
Root schema keyword costs, including required-name text, live in `inputSchema.overhead`; add this to root property totals to reconcile the schema total.


**Ground-truth counter**:
A caller-supplied function that returns the actual input token count for a request. It may be synchronous or asynchronous and determines the model the tuner fits.

**Probe**:
A controlled request that varies message, tool, media, or text features to measure named model parameters. Natural text requests can additionally refine text composition.

**Text selection samples**:
Separate documents used only to choose among the initial text rules, the probe calibration, and each text-refinement round. Final validation and the fixed text holdout do not select or fit parameters.

**Staged calibration**:
The model tuning procedure. Text-only anchors identify a multiplier and nuisance intercept, then labeled text contrasts measure individual ratios and gates. Controlled request differences identify structural overhead weights with the entire measured text profile fixed. Independent evaluation requests report error without influencing either phase.
Optional natural-text samples refine text composition by searching count-changing thresholds, with scale fixed and structural tallies removed. Separate selection documents select a round without entering fitting. Context contrasts diagnose boundary effects without fitting parameters. Repeatedly inspected development excerpts are distinct from the frozen document holdout used for the final Anthropic comparison; retire a holdout once its results guide changes.

**Controlled contrast**:
A before/after request pair that changes known features. Its actual token-count difference, less the directly measured cost of the changed text fragments, measures structural overhead. Those fragments are counted during the text phase with the single-message nuisance intercept removed. Costs that always change together are reported as inseparable, and residuals reveal costs missing from the feature tally.


**Reasoning payloads**:
A reasoning part with an encrypted payload (Anthropic `signature` or `redactedData`, OpenAI `reasoningEncryptedContent`, OpenRouter `reasoning_details`) costs `perReasoningPayloadChar × (length − reasoningPayloadEnvelopeChars)`; its visible summary is not counted, because the provider charges the decrypted hidden thinking. `countReasoningInPreviousTurns` says whether reasoning before the last user message is counted or dropped. The costs belong to the model, not to a reasoning level. `tuneProfile` fits them from at most 10 generated responses when it receives `invokeModel`. See "Tune a model profile" in the README.

## Tuning method

`tuneProfile` (src/tune/calibrate.ts) runs three fits on the built-in corpus (src/tune/corpus.ts), each with everything fitted earlier locked:

1. **Text.** One-character-word anchors give the multiplier and the single-message intercept. Labeled contrasts measure each ratio and gate (the short-segment gate together with punctuation); the German, Romance and Slavic Latin accent rules have no contrasts and are fitted on running text only. Natural-text refinement then searches the values where `ceil(length / ratio)` changes, one field at a time for four rounds, and separate selection documents choose among the initial rules, the probe calibration and each round. Ratios stay at or above 1 / (UTF-8 bytes per character).
2. **Overhead.** Every text fragment in the overhead probes is counted alone, so controlled before/after differences isolate the structural costs, which a rank-revealing QR solve fits.
3. **Reasoning** (only with `invokeModel`). At most 10 generations: 4 text prompts (two get a follow-up) and 2 tool-use prompts. Each history is counted with and without its payload reasoning parts; the difference isolates the hidden cost. A weighted least-squares fit gives a per-block and a per-character cost, once with previous-turn reasoning counted and once dropped, and keeps the better case; the negative per-block cost is stored as the envelope length.

Validation requests only report errors. Unmeasurable fields keep their initial values and are reported as `absent`, `collinear` or `invalid`.
