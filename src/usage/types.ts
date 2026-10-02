import type { JSONSchema7, ModelMessage, ToolSet } from 'ai'

export interface UsageInput {
  messages: readonly ModelMessage[]
  tools?: ToolSet
}

export interface EstimatorOptions {
  /**
   * Converts a tool input schema that the estimator cannot read, for example
   * a Zod 3 schema. Must be synchronous. Return `undefined` to count the
   * schema as empty.
   */
  toJsonSchema?: (schema: unknown) => JSONSchema7 | undefined
}

export interface CountOptions {
  /** Returns a breakdown of where the tokens come from instead of a number. */
  breakdown?: boolean
}

/**
 * Where the tokens of a request come from. The values are not rounded, so
 * they add up to the exact estimate; only `total` is rounded.
 */
export interface UsageBreakdown {
  /** The rounded estimate, equal to the result of `count()`. */
  total: number
  baseOverhead: number
  messages: MessageBreakdown[]
  tools: ToolsBreakdown
}

export interface MessageBreakdown {
  role: ModelMessage['role']
  total: number
  /** `perMessage`, plus `perSystem` for a system message. */
  overhead: number
  parts: PartBreakdown[]
}

export interface PartBreakdown {
  /** The part type, or `text` for string content. */
  type: string
  total: number
}

export interface ToolsBreakdown {
  /** All tool definitions together, including the overhead. */
  total: number
  /** `toolsExist`, plus `perTool` for each tool after the first. */
  overhead: number
  definitions: Record<string, ToolDefinitionBreakdown>
}

export interface ToolDefinitionBreakdown {
  total: number
  name: number
  /** `perDesc` plus the description text. */
  description: number
  inputSchema: SchemaBreakdown
}

export interface SchemaBreakdown {
  total: number
  /**
   * Keyed by property path, for example `filter.kind` or `items[].id`.
   * Local references are expanded at their use sites. The `nested`
   * value of a property includes the totals of its child properties.
   */
  properties: Record<string, PropertyBreakdown>
}

export interface PropertyBreakdown {
  total: number
  name: number
  /** `perFirstProp` or `perAdditionalProp`. */
  overhead: number
  /** `perPropDesc` plus the description text. */
  description: number
  /** `perEnum` plus the enum values. */
  enum: number
  /** `perNestedObject` or `perArrayOfObjects` plus the child properties. */
  nested: number
}
