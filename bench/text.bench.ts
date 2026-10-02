import { Tokenizer } from 'ai-tokenizer'
import * as claude from 'ai-tokenizer/encoding/claude'
import { encode } from 'gpt-tokenizer/encoding/o200k_base'
import { bench, describe } from 'vitest'
import { estimateTokenCount } from '../src/index'
import { BENCHMARK_SAMPLES, readSampleText } from '../test/fixtures/samples'

const corpus = (await Promise.all(BENCHMARK_SAMPLES.map(readSampleText))).join('\n')
const claudeTokenizer = new Tokenizer(claude)

// The BPE tokenizers cache merges, so repeated runs on one corpus show their
// warm-cache speed. A conversation that is counted again on each turn sees the
// same effect.
describe(`text corpus (${corpus.length.toLocaleString('en-US')} chars)`, () => {
  bench('tokenx estimateTokenCount', () => {
    estimateTokenCount(corpus)
  }, { time: 2000 })

  bench('gpt-tokenizer o200k_base encode', () => {
    encode(corpus)
  }, { time: 2000 })

  bench('ai-tokenizer claude count', () => {
    claudeTokenizer.count(corpus)
  }, { time: 2000 })
})
