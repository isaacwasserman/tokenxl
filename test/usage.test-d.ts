import type { ModelMessage, ToolSet } from 'ai'
import type { UsageBreakdown, UsageInput } from '../src/index'
import { jsonSchema, tool } from 'ai'
import { createUsageEstimator, estimateUsage } from '../src/index'

const messages: ModelMessage[] = [
  { role: 'system', content: 'Be brief.' },
  { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
]
const tools: ToolSet = { lookup: tool({ inputSchema: jsonSchema({ type: 'object', properties: { id: { type: 'string' } } }) }) }
const input: UsageInput = { messages, tools }
const estimator = createUsageEstimator()

export const count: number = estimator.count(input)
export const breakdown: UsageBreakdown = estimator.count(input, { breakdown: true })
export const convenienceCount: number = estimateUsage(input)
export const convenienceBreakdown: UsageBreakdown = estimateUsage(input, { breakdown: true })
export const optionalBreakdown: number | UsageBreakdown = estimator.count(input, { breakdown: Math.random() > 0.5 })
export const optionalConvenienceBreakdown: number | UsageBreakdown = estimateUsage(input, { breakdown: Math.random() > 0.5 })
