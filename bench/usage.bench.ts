import { models, Tokenizer } from 'ai-tokenizer'
import * as claude from 'ai-tokenizer/encoding/claude'
import { count } from 'ai-tokenizer/sdk'
import { bench, describe } from 'vitest'
import { createUsageEstimator } from '../src/index'
import { createBenchConversation, createBenchTools } from './conversation'

const messages = await createBenchConversation()
const tools = createBenchTools()
const input = { messages, tools }

const model = models['anthropic/claude-sonnet-4.5']
const tokenizer = new Tokenizer(claude)
const estimator = createUsageEstimator(model.tokens)

describe('50 messages and 10 tools', () => {
  bench('tokenx count', () => {
    estimator.count(input)
  }, { time: 2000 })

  bench('tokenx count with breakdown', () => {
    estimator.count(input, { breakdown: true })
  }, { time: 2000 })

  // A new estimator has an empty tool cache, so it also walks every schema.
  bench('tokenx count, new estimator', () => {
    createUsageEstimator(model.tokens).count(input)
  }, { time: 2000 })

  bench('ai-tokenizer count', () => {
    count({ tokenizer, model, messages, tools })
  }, { time: 2000 })
})
