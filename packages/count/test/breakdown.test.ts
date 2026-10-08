import type { ModelMessage, ToolSet } from "ai";
import { jsonSchema, tool } from "ai";
import { expect, it } from "vitest";
import { createUsageEstimator, estimateUsage } from "../src/index";
import { ZERO_COSTS } from "./fixtures/profile-fields.ts";

it("shows the shape of a basic request breakdown", () => {
  expect(
    createUsageEstimator().count(
      { messages: [{ role: "user", content: "Hello" }] },
      { breakdown: true },
    ),
  ).toMatchInlineSnapshot(`
    {
      "baseOverhead": 3,
      "messages": [
        {
          "overhead": 4,
          "parts": [
            {
              "total": 1,
              "type": "text",
            },
          ],
          "role": "user",
          "total": 5,
        },
      ],
      "tools": {
        "definitions": {},
        "overhead": 0,
        "total": 0,
      },
      "total": 8,
    }
  `);
});

it("accounts for message, tool and property costs without intermediate rounding", () => {
  const estimator = createUsageEstimator({
    contentMultiplier: 1.13,
    perMessage: 2.7,
    perTool: 5.1,
  });
  const messages: ModelMessage[] = [
    { role: "system", content: "Be brief." },
    {
      role: "user",
      content: [
        { type: "text", text: "Find something." },
        { type: "image", image: "AAAA" },
      ],
    },
  ];
  const tools = {
    search: tool({
      description: "Search the catalog",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          filter: {
            type: "object",
            description: "Filter results",
            properties: { kind: { enum: ["a", "b"] } },
          },
          rows: {
            type: "array",
            items: { type: "object", properties: { id: { type: "string" } } },
          },
        },
      }),
    }),
    ping: tool({ inputSchema: jsonSchema({ type: "object", properties: {} }) }),
  };
  const input = { messages, tools };
  const result = estimator.count(input, { breakdown: true });
  expect(result.total).toBe(estimator.count(input));
  expect(estimateUsage(input, { breakdown: true }).total).toBe(
    estimateUsage(input),
  );
  expect(
    Math.round(
      result.baseOverhead +
        result.messages.reduce((sum, message) => sum + message.total, 0) +
        result.tools.total,
    ),
  ).toBe(result.total);
  for (const message of result.messages)
    expect(
      message.overhead +
        message.parts.reduce((sum, part) => sum + part.total, 0),
    ).toBeCloseTo(message.total);
  expect(
    result.tools.overhead +
      Object.values(result.tools.definitions).reduce(
        (sum, definition) => sum + definition.total,
        0,
      ),
  ).toBeCloseTo(result.tools.total);
  for (const definition of Object.values(result.tools.definitions)) {
    expect(
      definition.name + definition.description + definition.inputSchema.total,
    ).toBeCloseTo(definition.total);
    for (const property of Object.values(definition.inputSchema.properties))
      expect(
        property.name +
          property.overhead +
          property.description +
          property.enum +
          property.nested,
      ).toBeCloseTo(property.total);
  }
  const properties = result.tools.definitions.search!.inputSchema.properties;
  expect(Object.keys(properties)).toEqual([
    "filter",
    "filter.kind",
    "rows",
    "rows[].id",
  ]);
  // Child costs are included in their parent's nested cost.
  expect(properties.filter!.total + properties.rows!.total).toBeCloseTo(
    result.tools.definitions.search!.inputSchema.total,
  );
  expect(properties.filter!.nested).toBeCloseTo(
    properties["filter.kind"]!.total + estimator.profile.perNestedObject,
  );

  // Returned breakdowns must not expose mutable objects from the tool cache.
  properties["filter.kind"]!.total = -1000;
  expect(
    estimator.count(input, { breakdown: true }).tools.definitions.search!
      .inputSchema.properties["filter.kind"]!.total,
  ).toBeGreaterThan(0);
});

it("preserves tool and property names that match Object prototype keys", () => {
  const tools = JSON.parse(
    '{"__proto__":{"inputSchema":{"type":"object","properties":{"__proto__":{"type":"string"},"constructor":{"type":"string"}}}}}',
  ) as ToolSet;
  const estimator = createUsageEstimator();
  const input = { messages: [], tools };
  const result = estimator.count(input, { breakdown: true });
  expect(Object.keys(result.tools.definitions)).toEqual(["__proto__"]);
  expect(
    Object.keys(
      Object.values(result.tools.definitions)[0]!.inputSchema.properties,
    ),
  ).toEqual(["__proto__", "constructor"]);
  expect(
    result.tools.overhead + Object.values(result.tools.definitions)[0]!.total,
  ).toBe(result.tools.total);
  expect(result.total).toBe(estimator.count(input));
});

it("aggregates repeated property paths across schema alternatives", () => {
  const tools = {
    lookup: {
      inputSchema: {
        anyOf: [
          { type: "object", properties: { id: { enum: ["one"] } } },
          { type: "object", properties: { id: { const: "two" } } },
        ],
      },
    },
  } as unknown as ToolSet;
  const result = createUsageEstimator().count(
    { messages: [], tools },
    { breakdown: true },
  );
  const schema = result.tools.definitions.lookup!.inputSchema;
  expect(schema.properties.id!.total).toBeCloseTo(schema.total);
});

it("accounts for new schema costs in root and property breakdowns and cached totals", () => {
  const estimator = createUsageEstimator({
    ...ZERO_COSTS,
    contentMultiplier: 2,
    perRequired: 6,
    perRequiredProp: 2,
    perAdditionalProperties: 10,
    perInteger: 1,
    perBoolean: 2,
    perArrayOfPrimitives: 12,
    perEnumValue: 3,
  });
  const input = {
    messages: [],
    tools: {
      a: tool({
        inputSchema: jsonSchema({
          type: "object",
          additionalProperties: false,
          required: ["flag", "status"],
          properties: {
            flag: { type: "boolean" },
            status: { enum: ["a", "b", "c"] },
            count: { type: "integer" },
            items: { type: "array", items: { type: "integer" } },
            config: {
              type: "object",
              additionalProperties: false,
              required: ["enabled"],
              properties: { enabled: { type: "boolean" } },
            },
          },
        }),
      }),
    },
  };
  expect(estimator.count(input)).toBe(91);
  const result = estimator.count(input, { breakdown: true });
  const schema = result.tools.definitions.a!.inputSchema;
  expect(result.total).toBe(91);
  expect(schema.overhead).toBe(24);
  expect(schema.properties.flag!.overhead).toBe(2);
  expect(schema.properties.status!.enum).toBe(15);
  expect(schema.properties.items!.nested).toBe(13);
  expect(schema.properties.config!.overhead).toBe(20);
  expect(schema.properties.config!.nested).toBe(4);
  const topLevel = Object.entries(schema.properties).filter(
    ([path]) => !path.includes("."),
  );
  expect(
    schema.overhead +
      topLevel.reduce((sum, [, property]) => sum + property.total, 0),
  ).toBe(schema.total);
  for (const property of Object.values(schema.properties))
    expect(
      property.name +
        property.overhead +
        property.description +
        property.enum +
        property.nested,
    ).toBe(property.total);
  expect(estimator.count(input, { breakdown: true })).toEqual(result);
  expect(estimator.count(input)).toBe(result.total);
});
