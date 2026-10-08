import type { JSONSchema7, ToolSet } from "ai";
import { Feature, TALLY_LENGTH } from "../profile.ts";
import type { WalkContext } from "./context.ts";
import { addJson, addTally, addText, tallyValue } from "./context.ts";
import type {
  EstimatorOptions,
  PropertyBreakdown,
  SchemaBreakdown,
  ToolDefinitionBreakdown,
  ToolsBreakdown,
} from "./types.ts";

// Stops a walk through pathologically deep schemas.
const MAX_SCHEMA_DEPTH = 64;

// Keywords that annotate or constrain a value; providers render them with it.
// Their values are short in practice, so their weights cover them.
const ANNOTATION_KEYWORDS = [
  "title",
  "default",
  "examples",
  "format",
  "pattern",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
] as const;

type SchemaNode = Record<string, unknown>;

/** The cost of one tool without its name, which comes from the tool set key. */
export interface ToolEntry {
  tally: Float64Array;
  breakdown?: Omit<ToolDefinitionBreakdown, "total" | "name"> & {
    total: number;
  };
}

export type ToolCache = WeakMap<object, ToolEntry>;

export function walkToolSet(
  tools: ToolSet,
  context: WalkContext,
  options: EstimatorOptions,
  breakdown?: ToolsBreakdown,
  cache?: ToolCache,
): void {
  const names = Object.keys(tools);
  if (names.length === 0) return;

  const { tally } = context;
  const start = breakdown ? tallyValue(context) : 0;

  // `toolsExist` covers the fixed cost of the first tool.
  tally[Feature.toolsExist]!++;
  tally[Feature.perTool]! += names.length - 1;

  if (breakdown) breakdown.overhead = tallyValue(context) - start;

  for (const name of names) {
    const tool: unknown = tools[name];
    const toolStart = breakdown ? tallyValue(context) : 0;

    addText(context, name);
    const nameTokens = breakdown ? tallyValue(context) - toolStart : 0;

    if (typeof tool !== "object" || tool === null) continue;

    const entry = toolEntry(
      tool,
      context,
      options,
      breakdown !== undefined,
      cache,
    );
    addTally(tally, entry.tally);

    if (breakdown) {
      const { total, description, inputSchema } = entry.breakdown!;
      // Cached breakdowns are copied so callers can modify the result.
      const properties = cache
        ? copyProperties(inputSchema.properties)
        : inputSchema.properties;
      breakdown.definitions[name] = {
        total: nameTokens + total,
        name: nameTokens,
        description,
        inputSchema: { ...inputSchema, properties },
      };
    }
  }

  if (breakdown) breakdown.total = tallyValue(context) - start;
}

function toolEntry(
  tool: object,
  context: WalkContext,
  options: EstimatorOptions,
  withBreakdown: boolean,
  cache?: ToolCache,
): ToolEntry {
  // Extraction needs the text of every occurrence, including aliased tools.
  const cached = context.onText ? undefined : cache?.get(tool);
  if (cached && (cached.breakdown || !withBreakdown)) return cached;

  const toolContext: WalkContext = {
    ...context,
    tally: new Float64Array(TALLY_LENGTH),
  };
  const { description, inputSchema } = tool as {
    description?: unknown;
    inputSchema?: unknown;
  };

  if (typeof description === "string" && description) {
    toolContext.tally[Feature.perDesc]!++;
    addText(toolContext, description);
  }
  const descriptionTokens = withBreakdown ? tallyValue(toolContext) : 0;

  const schemaBreakdown: SchemaBreakdown | undefined = withBreakdown
    ? { total: 0, overhead: 0, properties: Object.create(null) }
    : undefined;
  const jsonSchema = resolveJsonSchema(inputSchema, options);
  if (jsonSchema)
    walkRootSchema(jsonSchema as SchemaNode, toolContext, schemaBreakdown);

  const entry: ToolEntry = { tally: toolContext.tally };
  if (schemaBreakdown) {
    const total = tallyValue(toolContext);
    schemaBreakdown.total = total - descriptionTokens;
    entry.breakdown = {
      total,
      description: descriptionTokens,
      inputSchema: schemaBreakdown,
    };
  }

  cache?.set(tool, entry);
  return entry;
}

function copyProperties(
  properties: Record<string, PropertyBreakdown>,
): Record<string, PropertyBreakdown> {
  const copy: Record<string, PropertyBreakdown> = Object.create(null);
  for (const path of Object.keys(properties))
    copy[path] = { ...properties[path]! };
  return copy;
}

/**
 * Reads the JSON Schema of an AI SDK input schema: a `Schema` from
 * `jsonSchema()` or `zodSchema()`, a lazy schema, a Standard JSON Schema
 * (Zod 4.2 and later, ArkType, and others) or a plain JSON Schema object.
 */
export function resolveJsonSchema(
  schema: unknown,
  options: EstimatorOptions = {},
): JSONSchema7 | undefined {
  if (
    schema === null ||
    (typeof schema !== "object" && typeof schema !== "function")
  )
    return;

  assertSync(schema);
  const candidate = schema as SchemaNode;

  if ("jsonSchema" in candidate)
    return assertSync(candidate.jsonSchema) as JSONSchema7;

  const standard = candidate["~standard"] as
    | { jsonSchema?: { input?: (options: { target: string }) => unknown } }
    | undefined;
  if (typeof standard?.jsonSchema?.input === "function")
    return assertSync(
      standard.jsonSchema.input({ target: "draft-07" }),
    ) as JSONSchema7;

  // A lazy schema is a function that returns the schema. Callable schemas
  // such as ArkType types match the Standard JSON Schema check first.
  if (typeof schema === "function" && standard === undefined)
    return resolveJsonSchema(assertSync((schema as () => unknown)()), options);

  if (
    typeof schema === "object" &&
    standard === undefined &&
    isJsonSchemaObject(candidate)
  )
    return candidate as JSONSchema7;

  if (options.toJsonSchema)
    return assertSync(options.toJsonSchema(schema)) as JSONSchema7 | undefined;
}

function isJsonSchemaObject(node: SchemaNode): boolean {
  return (
    "type" in node ||
    "properties" in node ||
    "anyOf" in node ||
    "oneOf" in node ||
    "allOf" in node ||
    "$ref" in node
  );
}

function assertSync<T>(value: T): T {
  if (isPromiseLike(value)) {
    throw new TypeError(
      "tokenx: The tool input schema resolves asynchronously. Estimation is synchronous, so resolve the JSON Schema first and pass it as a plain object or `jsonSchema(resolvedSchema)`.",
    );
  }
  return value;
}

function isPromiseLike(value: unknown): boolean {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as PromiseLike<unknown>).then === "function"
  );
}

function walkRootSchema(
  root: SchemaNode,
  context: WalkContext,
  breakdown?: SchemaBreakdown,
): void {
  new SchemaWalker(root, context, breakdown).walkObjectLevel(root, "", 0);
}

/** Visits every schema branch of a node's `anyOf`, `oneOf`, and `allOf`. */
function forEachBranch(
  node: SchemaNode,
  visit: (branch: SchemaNode) => void,
): void {
  for (const combinator of ["anyOf", "oneOf", "allOf"] as const) {
    const branches = node[combinator];
    if (Array.isArray(branches))
      for (const branch of branches) if (isSchemaNode(branch)) visit(branch);
  }
}

/** Resolves local references along the current path, stopping recursive references. */
class SchemaWalker {
  private readonly activeReferences = new Set<string>();

  private readonly root: SchemaNode;
  private readonly context: WalkContext;
  private readonly properties: Record<string, PropertyBreakdown> | undefined;
  private readonly breakdown: SchemaBreakdown | undefined;

  constructor(
    root: SchemaNode,
    context: WalkContext,
    breakdown?: SchemaBreakdown,
  ) {
    this.root = root;
    this.context = context;
    this.properties = breakdown?.properties;
    this.breakdown = breakdown;
  }

  walkObjectLevel(node: SchemaNode, path: string, depth: number): void {
    if (depth > MAX_SCHEMA_DEPTH) return;

    const start = this.breakdown && !path ? tallyValue(this.context) : 0;
    this.walkKeywords(node);
    if (this.breakdown && !path)
      this.breakdown.overhead += tallyValue(this.context) - start;

    if (typeof node.$ref === "string") {
      this.withReference(node.$ref, (referenced) =>
        this.walkObjectLevel(referenced, path, depth + 1),
      );
    }

    this.walkProperties(node, path, depth);

    forEachBranch(node, (branch) =>
      this.walkObjectLevel(branch, path, depth + 1),
    );
  }

  private walkProperties(node: SchemaNode, path: string, depth: number): void {
    if (isSchemaNode(node.properties)) {
      let isFirst = true;
      for (const key of Object.keys(node.properties)) {
        const property = node.properties[key];
        this.walkProperty(
          key,
          isSchemaNode(property) ? property : {},
          isFirst,
          path,
          depth,
        );
        isFirst = false;
      }
    }
  }

  private walkProperty(
    key: string,
    property: SchemaNode,
    isFirst: boolean,
    parentPath: string,
    depth: number,
  ): void {
    const { context, properties } = this;
    const path = parentPath ? `${parentPath}.${key}` : key;
    const start = properties ? tallyValue(context) : 0;
    const prior = properties?.[path];
    if (properties && !prior)
      properties[path] = {
        total: 0,
        name: 0,
        overhead: 0,
        description: 0,
        enum: 0,
        nested: 0,
      };

    addText(context, key);
    const name = properties ? tallyValue(context) - start : 0;
    context.tally[
      isFirst ? Feature.perFirstProp : Feature.perAdditionalProp
    ]!++;
    const valueStart = properties ? tallyValue(context) : 0;
    const detail = properties
      ? { overhead: 0, description: 0, enum: 0, nested: 0 }
      : undefined;
    this.walkValue(property, path, depth + 1, detail);

    if (properties && detail) {
      const entry: PropertyBreakdown = {
        total: tallyValue(context) - start,
        name,
        overhead: valueStart - start - name + detail.overhead,
        description: detail.description,
        enum: detail.enum,
        nested: detail.nested,
      };
      // Combinator branches can define the same property path.
      if (prior) {
        for (const field of Object.keys(entry) as Array<
          keyof PropertyBreakdown
        >)
          entry[field] += prior[field];
      }
      properties[path] = entry;
    }
  }

  private walkValue(
    node: SchemaNode,
    path: string,
    depth: number,
    detail?: {
      overhead: number;
      description: number;
      enum: number;
      nested: number;
    },
  ): void {
    if (depth > MAX_SCHEMA_DEPTH) return;
    const { context } = this;
    const { tally } = context;
    let start = detail ? tallyValue(context) : 0;
    this.walkKeywords(node);
    if (detail) detail.overhead += tallyValue(context) - start;
    start = detail ? tallyValue(context) : 0;
    if (typeof node.description === "string" && node.description) {
      tally[Feature.perPropDesc]!++;
      addText(context, node.description);
    }
    if (detail) detail.description += tallyValue(context) - start;

    start = detail ? tallyValue(context) : 0;
    // A union renders each further member, such as `| null`.
    if (Array.isArray(node.type) && node.type.length > 1)
      tally[Feature.perUnionMember]! += node.type.length - 1;
    if (node.nullable === true) tally[Feature.perUnionMember]!++;
    for (const combinator of ["anyOf", "oneOf"] as const) {
      const branches = node[combinator];
      if (Array.isArray(branches) && branches.length > 1)
        tally[Feature.perUnionBranch]! += branches.length - 1;
    }
    let keywords = 0;
    for (const keyword of ANNOTATION_KEYWORDS) {
      if (node[keyword] === undefined) continue;
      tally[
        keywords++
          ? Feature.perAdditionalSchemaKeyword
          : Feature.perSchemaKeyword
      ]!++;
    }
    if (detail) detail.overhead += tallyValue(context) - start;

    start = detail ? tallyValue(context) : 0;
    if (Array.isArray(node.enum)) {
      tally[Feature.perEnum]!++;
      tally[Feature.perEnumValue]! += node.enum.length;
      for (const value of node.enum) addJsonValue(context, value);
    } else if ("const" in node) {
      tally[Feature.perEnum]!++;
      addJsonValue(context, node.const);
    }
    if (detail) detail.enum += tallyValue(context) - start;

    // A reference is interpreted at its use site. Ancestor references stop
    // here, while independent uses of one definition are each counted.
    if (typeof node.$ref === "string")
      this.withReference(node.$ref, (referenced) =>
        this.walkValue(referenced, path, depth + 1, detail),
      );

    start = detail ? tallyValue(context) : 0;
    if (isObjectSchema(node)) {
      tally[Feature.perNestedObject]!++;
      this.walkProperties(node, path, depth);
    } else if (isArraySchema(node)) {
      const items = Array.isArray(node.items) ? node.items : [node.items];
      for (const element of items) {
        if (!isSchemaNode(element)) continue;
        this.walkArrayItem(element, `${path}[]`, depth + 1);
      }
    }
    if (detail) detail.nested += tallyValue(context) - start;

    forEachBranch(node, (branch) =>
      this.walkValue(branch, path, depth + 1, detail),
    );
  }

  private walkArrayItem(node: SchemaNode, path: string, depth: number): void {
    if (depth > MAX_SCHEMA_DEPTH) return;
    const item = unwrapNullable(node);
    if (typeof item.$ref === "string") {
      this.withReference(item.$ref, (referenced) =>
        this.walkArrayItem(referenced, path, depth + 1),
      );
    } else if (isObjectSchema(item)) {
      this.context.tally[Feature.perArrayOfObjects]!++;
      this.walkObjectLevel(item, path, depth);
    } else if (
      Array.isArray(item.anyOf) ||
      Array.isArray(item.oneOf) ||
      Array.isArray(item.allOf)
    ) {
      forEachBranch(item, (branch) =>
        this.walkArrayItem(branch, path, depth + 1),
      );
    } else {
      if (isPrimitiveSchema(item))
        this.context.tally[Feature.perArrayOfPrimitives]!++;
      this.walkValue(item, path, depth);
    }
  }

  private walkKeywords(node: SchemaNode): void {
    const { context } = this;
    if (node.additionalProperties !== undefined)
      context.tally[Feature.perAdditionalProperties]!++;
    if (
      node.additionalProperties === true ||
      isSchemaNode(node.additionalProperties)
    )
      context.tally[Feature.perAdditionalPropertiesTrue]!++;
    if (hasType(node, "integer")) context.tally[Feature.perInteger]!++;
    if (hasType(node, "boolean")) context.tally[Feature.perBoolean]!++;
    if (Array.isArray(node.required)) {
      context.tally[Feature.perRequired]!++;
      let names = 0;
      for (const name of node.required) {
        if (typeof name === "string") {
          names++;
          addText(context, name);
        }
      }
      context.tally[Feature.perRequiredProp]! += names;
    }
  }

  private withReference(
    reference: string,
    visit: (node: SchemaNode) => void,
  ): void {
    if (
      (reference !== "#" && !reference.startsWith("#/")) ||
      this.activeReferences.has(reference)
    )
      return;
    let node: unknown = this.root;
    for (const part of reference === "#" ? [] : reference.slice(2).split("/")) {
      const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
      if (!isSchemaNode(node) || !Object.hasOwn(node, key)) return;
      node = node[key];
    }
    if (!isSchemaNode(node)) return;
    this.activeReferences.add(reference);
    visit(node);
    this.activeReferences.delete(reference);
  }
}

/** Replaces `anyOf`/`oneOf` of one schema and `null` with that schema. */
function unwrapNullable(node: SchemaNode): SchemaNode {
  const branches = node.anyOf ?? node.oneOf;
  if (!Array.isArray(branches) || branches.length !== 2) return node;

  const [first, second] = branches;
  if (isNullSchema(second) && isSchemaNode(first)) return first;
  if (isNullSchema(first) && isSchemaNode(second)) return second;
  return node;
}

function isNullSchema(node: unknown): boolean {
  return isSchemaNode(node) && node.type === "null";
}

function isObjectSchema(node: SchemaNode): boolean {
  return hasType(node, "object") || isSchemaNode(node.properties);
}

function isArraySchema(node: SchemaNode): boolean {
  return hasType(node, "array") || "items" in node;
}

function isPrimitiveSchema(node: SchemaNode): boolean {
  return (
    hasType(node, "string") ||
    hasType(node, "number") ||
    hasType(node, "integer") ||
    hasType(node, "boolean") ||
    hasType(node, "null") ||
    "enum" in node ||
    "const" in node
  );
}

function hasType(node: SchemaNode, type: string): boolean {
  const nodeType = node.type;
  return (
    nodeType === type || (Array.isArray(nodeType) && nodeType.includes(type))
  );
}

function isSchemaNode(value: unknown): value is SchemaNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addJsonValue(context: WalkContext, value: unknown): void {
  if (typeof value === "string") addText(context, value);
  else addJson(context, value);
}
