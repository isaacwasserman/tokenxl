import { describe, expect, it } from "vitest";
import type { ModelProfile, UsageInput } from "../src/index.ts";
import { createUsageEstimator } from "../src/index.ts";
import { ZERO_COSTS } from "./fixtures/profile-fields.ts";

// The image geometry of Claude Sonnet 5.5, as measured; only images cost tokens.
const claude: ModelProfile = {
  ...ZERO_COSTS,
  perImage: 3,
  perImagePatch: 1,
  perToolResultImage: 10,
  imagePatchSize: 28,
  imageMaxEdge: 2576,
  imageMaxPatches: 4784,
};
const gpt51: ModelProfile = {
  ...ZERO_COSTS,
  perImage: 70,
  perImagePatch: 140,
  imagePatchSize: 512,
  imageMaxEdge: 2048,
  imageMaxShortEdge: 768,
};

/** The header of a PNG: the signature and an IHDR chunk. */
function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  bytes.set(
    [..."IHDR"].map((c) => c.charCodeAt(0)),
    12,
  );
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes.set([8, 2, 0, 0, 0], 24);
  return bytes;
}

const base64 = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes));

function imageRequest(image: unknown): UsageInput {
  return {
    messages: [{ role: "user", content: [{ type: "image", image } as never] }],
  };
}

describe("image costs", () => {
  it("counts the patches of the resized image, as the provider measures them", () => {
    const estimator = createUsageEstimator(claude);
    // [width, height, measured tokens]
    for (const [width, height, tokens] of [
      [200, 120, 43],
      [1000, 1000, 1299],
      [4000, 3000, 4743],
      [4000, 50, 187],
      [8000, 1, 95],
      [1000, 3000, 2855],
    ] as const)
      expect(estimator.count(imageRequest(png(width, height)))).toBe(tokens);
    const tiles = createUsageEstimator(gpt51);
    for (const [width, height, tokens] of [
      [1000, 1000, 630],
      [4000, 50, 630],
      [8000, 8000, 630],
    ] as const)
      expect(tiles.count(imageRequest(png(width, height)))).toBe(tokens);
  });

  it("reads PNG, GIF, WebP and JPEG sizes from bytes, base64, data URLs and tagged data", () => {
    const estimator = createUsageEstimator(claude);
    const expected = 3 + Math.ceil(100 / 28) * Math.ceil(60 / 28);
    const gif = new Uint8Array([
      ..."GIF89a".split("").map((c) => c.charCodeAt(0)),
      100,
      0,
      60,
      0,
    ]);
    const webp = new Uint8Array(30);
    webp.set([..."RIFF"].map((c) => c.charCodeAt(0)));
    webp.set(
      [..."WEBPVP8X"].map((c) => c.charCodeAt(0)),
      8,
    );
    webp.set([99, 0, 0, 59, 0, 0], 24);
    // A JPEG with an APP0 segment before its start-of-frame segment.
    const jpeg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 60, 0, 100,
      3, 0, 0, 0,
    ]);
    for (const data of [
      png(100, 60),
      png(100, 60).buffer,
      base64(png(100, 60)),
      `data:image/png;base64,${base64(png(100, 60))}`,
      { type: "data", data: base64(png(100, 60)) },
      gif,
      webp,
      base64(jpeg),
    ])
      expect(estimator.count(imageRequest(data))).toBe(expected);
  });

  it("counts an image of unknown size as 1024 × 1024 pixels", () => {
    const estimator = createUsageEstimator(claude);
    const unknown = 3 + 37 * 37;
    expect(
      estimator.count(imageRequest(new URL("https://example.com/a.png"))),
    ).toBe(unknown);
    expect(estimator.count(imageRequest("https://example.com/a.png"))).toBe(
      unknown,
    );
    expect(estimator.count(imageRequest("not an image"))).toBe(unknown);
  });

  it("adds perToolResultImage for images in tool results, and file parts with an image type are images", () => {
    const estimator = createUsageEstimator(claude);
    const data = base64(png(100, 60));
    const image = 3 + 4 * 3;
    expect(
      estimator.count({
        messages: [
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "call_1",
                toolName: "a",
                output: {
                  type: "content",
                  value: [{ type: "image-data", data, mediaType: "image/png" }],
                },
              },
            ],
          },
        ],
      }),
    ).toBe(image + 10);
    expect(
      estimator.count({
        messages: [
          {
            role: "user",
            content: [{ type: "file", data, mediaType: "image/png" }],
          },
        ],
      }),
    ).toBe(image);
  });

  it("keeps a fixed cost for each image without perImagePatch", () => {
    const estimator = createUsageEstimator({ ...ZERO_COSTS, perImage: 85 });
    expect(estimator.count(imageRequest(png(4000, 3000)))).toBe(85);
  });
});
