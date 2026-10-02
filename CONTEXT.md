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

**Feature tally**:
The unweighted counts of request features and estimated text tokens produced by the usage walker. Its dot product with profile weights gives the unrounded estimate.

**Breakdown**:
An optional account of token costs by message, part, tool, and schema property. Component costs retain fractions; only the request total is rounded. Child properties are included in their parent's nested cost.
