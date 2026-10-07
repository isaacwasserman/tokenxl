import type { JSONSchema7, ModelMessage, ToolSet } from "ai";

export interface UsageInput {
  messages: readonly ModelMessage[];
  tools?: ToolSet;
}

export interface EstimatorOptions {
  /**
   * Converts a tool input schema that the estimator cannot read, for example
   * a Zod 3 schema. Must be synchronous. Return `undefined` to count the
   * schema as empty.
   */
  toJsonSchema?: (schema: unknown) => JSONSchema7 | undefined;
  /**
   * Reuse the cost of each tool object and the estimates of repeated strings
   * and words. Default `true`; set `false` to keep no state between calls.
   * With caching, do not mutate a tool after the estimator has seen it.
   */
  cache?: boolean;
}

export interface CountOptions {
  /** Returns a breakdown of where the tokens come from instead of a number. */
  breakdown?: boolean;
}

/**
 * Where the tokens of a request come from. The values are not rounded, so
 * they add up to the exact estimate; only `total` is rounded.
 */
export interface UsageBreakdown {
  /** The rounded estimate, equal to the result of `count()`. */
  total: number;
  baseOverhead: number;
  messages: MessageBreakdown[];
  tools: ToolsBreakdown;
}

export interface MessageBreakdown {
  role: ModelMessage["role"];
  total: number;
  /** `perMessage`, plus `perSystem` for a system message. */
  overhead: number;
  parts: PartBreakdown[];
}

export interface PartBreakdown {
  /** The part type, or `text` for string content. */
  type: string;
  total: number;
}

export interface ToolsBreakdown {
  /** All tool definitions together, including the overhead. */
  total: number;
  /** `toolsExist`, plus `perTool` for each tool after the first. */
  overhead: number;
  definitions: Record<string, ToolDefinitionBreakdown>;
}

export interface ToolDefinitionBreakdown {
  total: number;
  name: number;
  /** `perDesc` plus the description text. */
  description: number;
  inputSchema: SchemaBreakdown;
}

export interface SchemaBreakdown {
  total: number;
  /** Root schema keywords, including required-list syntax and required names. */
  overhead: number;
  /**
   * Keyed by property path, for example `filter.kind` or `items[].id`.
   * Local references are expanded at their use sites. The `nested`
   * value of a property includes the totals of its child properties.
   */
  properties: Record<string, PropertyBreakdown>;
}

export interface PropertyBreakdown {
  total: number;
  name: number;
  /** Property position plus its schema type, keyword and required-list costs. */
  overhead: number;
  /** `perPropDesc` plus the description text. */
  description: number;
  /** `perEnum`, `perEnumValue` and the enum value text. */
  enum: number;
  /** Object/array item costs plus child properties and their schema keywords. */
  nested: number;
}
