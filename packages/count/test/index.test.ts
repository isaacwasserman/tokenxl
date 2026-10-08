import { describe, expect, it } from "vitest";
import { countText, fitsText, sliceText, splitText } from "./fixtures/text.ts";

/**
 * Pins the slice snapshots below to a ratio of the test's own choosing, so
 * recalibrating the shipped ratios moves the benchmark rather than these tests.
 */
const FIXED_OPTIONS = { defaultCharsPerToken: 4, languageConfigs: [] };

/** Every word costs one token, so slice boundaries land between words. */
const SINGLE_TOKEN_WORDS = "The old cat sat on a warm red mat.";
/** The long words cost several tokens each, so slice boundaries land inside them. */
const MULTI_TOKEN_WORDS =
  "Die pünktlich gewünschte Trüffelfüllung im übergestülpten Würzkümmel-Würfel ist kümmerlich und dürfte fürderhin zu Rüffeln in Hülle und Fülle führen.";

describe("estimateTokenCount", () => {
  it("returns zero for empty input", () => {
    expect(countText("")).toBe(0);
    expect(countText()).toBe(0);
  });

  describe("pricing rules", () => {
    it("prices kana runs below one token per character", () => {
      const kana = "こんにちはみなさん";
      expect(countText(kana)).toBeLessThan(kana.length);
    });

    it("prices han characters below one token each", () => {
      const han = "人工智能技术发展迅速";
      expect(countText(han)).toBeLessThan(han.length);
    });

    it("prices hangul below one token each", () => {
      const hangul = "안녕하세요반갑습니다";
      expect(countText(hangul)).toBeLessThan(hangul.length);
    });

    it("prices digit runs in groups of three", () => {
      expect(countText("123")).toBe(1);
      expect(countText("1234567890")).toBe(4);
    });

    it("prices emoji above one token per character", () => {
      const emoji = "🏀🔥";
      expect(countText(emoji)).toBeGreaterThan(Array.from(emoji).length);
    });

    it("prices words with an attached pictographic symbol like plain words", () => {
      expect(countText("Gutenberg™")).toBe(countText("Gutenbergs"));
    });

    it("prices URLs well below one token per character", () => {
      const url = "https://example.com/path/to/resource";
      expect(countText(url)).toBeLessThan(url.length / 2);
    });

    it("prices indentation and blank lines as one token", () => {
      expect(countText("Hello\n  world")).toBe(countText("Hello world") + 1);
      expect(countText("Hello\n\nworld")).toBe(countText("Hello world") + 1);
    });

    it("charges a line break that follows a word", () => {
      expect(countText("Hello\nworld")).toBe(countText("Hello world") + 1);
    });

    it("merges a line break into a preceding punctuation token", () => {
      expect(countText("Hello,\nworld")).toBe(countText("Hello, world"));
    });
  });

  describe("options", () => {
    it("returns more tokens for a lower defaultCharsPerToken", () => {
      const input = "Hello world";
      const defaultCount = countText(input);
      const customCount = countText(input, {
        defaultCharsPerToken: 4,
      });

      expect(customCount).toBeGreaterThan(defaultCount);
    });

    it("lets custom language configs override built-in CJK handling", () => {
      const input = "你好世界你好世界";
      const customOptions = {
        languageConfigs: [
          { pattern: /[\u4E00-\u9FFF]/, averageCharsPerToken: 2 },
        ],
      };

      expect(countText(input, customOptions)).toBe(4);
      expect(countText(input, customOptions)).not.toBe(countText(input));
    });

    it("ignores stateful regex flags in language configs", () => {
      const input = "éléphant éléphant éléphant éléphant";
      const statefulOptions = {
        languageConfigs: [{ pattern: /[éè]/g, averageCharsPerToken: 3 }],
      };
      const statelessOptions = {
        languageConfigs: [{ pattern: /[éè]/, averageCharsPerToken: 3 }],
      };

      expect(countText(input, statefulOptions)).toBe(
        countText(input, statelessOptions),
      );
    });

    it("applies custom language configs that only match ASCII", () => {
      const input = "hello world hello world";
      const asciiOptions = {
        languageConfigs: [{ pattern: /[aeiou]/, averageCharsPerToken: 2 }],
      };

      expect(countText(input, asciiOptions)).toBeGreaterThan(countText(input));
    });

    it("applies each text rule ratio", () => {
      expect(countText("------------")).toBe(2);
      expect(countText("------------", { punctuationCharsPerToken: 2 })).toBe(
        6,
      );

      expect(countText("123456789")).toBe(3);
      expect(countText("123456789", { digitsPerToken: 9 })).toBe(1);

      expect(countText("ABCDEFGHIJ")).toBe(2);
      expect(countText("ABCDEFGHIJ", { shortTokenThreshold: 10 })).toBe(1);

      expect(countText("abcdefghijkl")).toBe(2);
      expect(countText("abcdefghijkl", { lowercaseWordMaxLength: 12 })).toBe(1);

      expect(countText("人工智能技术")).toBe(6);
      expect(countText("人工智能技术", { hanziCharsPerToken: 3 })).toBe(2);

      expect(countText("こんにちは")).toBe(4);
      expect(countText("こんにちは", { kanaCharsPerToken: 5 })).toBe(1);

      expect(countText("안녕하세요")).toBe(4);
      expect(countText("안녕하세요", { hangulCharsPerToken: 5 })).toBe(1);
    });

    it("overrides the ratio of a built-in language config by name", () => {
      expect(countText("Größenordnung")).toBe(5);
      expect(
        countText("Größenordnung", {
          languageCharsPerToken: { german: 13 },
        }),
      ).toBe(1);
      expect(
        countText("Größenordnung", {
          languageCharsPerToken: { cyrillic: 1 },
        }),
      ).toBe(5);
    });

    it("ignores language ratio overrides when custom language configs are set", () => {
      const input = "Größenordnung";
      expect(
        countText(input, {
          languageConfigs: [],
          languageCharsPerToken: { german: 13 },
        }),
      ).toBe(countText(input, { languageConfigs: [] }));
    });

    it("treats undefined options as the defaults", () => {
      const input = "Die Größenordnung of 12345 tokens – 人工智能.";
      expect(
        countText(input, {
          defaultCharsPerToken: undefined,
          languageConfigs: undefined,
        }),
      ).toBe(countText(input));
    });
  });
});

describe("isWithinTokenLimit", () => {
  it("returns true when the input is within the token limit", () => {
    expect(fitsText("Short input.", 10)).toBe(true);
  });

  it("returns false when the input exceeds the token limit", () => {
    const input =
      "This is a much longer input that should exceed the token limit set for this test case.";
    expect(fitsText(input, 10)).toBe(false);
  });

  it("treats the limit as inclusive", () => {
    const input = "Boundary check input";
    const exactLimit = countText(input);

    expect(fitsText(input, exactLimit)).toBe(true);
    expect(fitsText(input, exactLimit - 1)).toBe(false);
  });

  it("flips the verdict under stricter custom options", () => {
    const input = "Hello world";
    const tokenLimit = 3;
    const customOptions = { defaultCharsPerToken: 2 };

    expect(fitsText(input, tokenLimit)).toBe(true);
    expect(fitsText(input, tokenLimit, customOptions)).toBe(false);
  });
});

describe("sliceByTokens", () => {
  it("returns an empty string for empty input", () => {
    expect(sliceText("")).toBe("");
    expect(sliceText("", 0, 5)).toBe("");
  });

  it("returns the entire text when no bounds are given", () => {
    expect(sliceText(SINGLE_TOKEN_WORDS)).toBe(SINGLE_TOKEN_WORDS);
  });

  it("reconstructs the input from adjacent slices", () => {
    const firstTwoTokens = sliceText(SINGLE_TOKEN_WORDS, 0, 2, FIXED_OPTIONS);
    const fromThirdToken = sliceText(
      SINGLE_TOKEN_WORDS,
      2,
      undefined,
      FIXED_OPTIONS,
    );

    expect(firstTwoTokens).toMatchInlineSnapshot(`"The old"`);
    expect(fromThirdToken).toMatchInlineSnapshot(
      `" cat sat on a warm red mat."`,
    );
    expect(firstTwoTokens + fromThirdToken).toBe(SINGLE_TOKEN_WORDS);
  });

  it("cuts inside a segment when the boundary falls mid-word", () => {
    expect(
      sliceText(MULTI_TOKEN_WORDS, 0, 3, FIXED_OPTIONS),
    ).toMatchInlineSnapshot(`"Die pünktl"`);
    expect(
      sliceText(MULTI_TOKEN_WORDS, 5, 10, FIXED_OPTIONS),
    ).toMatchInlineSnapshot(`"ünschte Trüffelfüll"`);
  });

  it("counts back from the end for negative indices", () => {
    expect(
      sliceText(MULTI_TOKEN_WORDS, -3, undefined, FIXED_OPTIONS),
    ).toMatchInlineSnapshot(`" führen."`);
    expect(
      sliceText(MULTI_TOKEN_WORDS, -8, -3, FIXED_OPTIONS),
    ).toMatchInlineSnapshot(`" Hülle und Fülle"`);

    const withoutLastTwo = sliceText(MULTI_TOKEN_WORDS, 0, -2, FIXED_OPTIONS);
    expect(MULTI_TOKEN_WORDS.startsWith(withoutLastTwo)).toBe(true);
    expect(withoutLastTwo.length).toBeLessThan(MULTI_TOKEN_WORDS.length);
  });

  it("returns an empty string when the range is empty or inverted", () => {
    expect(sliceText(MULTI_TOKEN_WORDS, 10, 5)).toBe("");
    expect(sliceText(MULTI_TOKEN_WORDS, 5, 5)).toBe("");
  });

  it("clamps out-of-range indices like Array.prototype.slice", () => {
    const totalTokens = countText(MULTI_TOKEN_WORDS);

    expect(sliceText(MULTI_TOKEN_WORDS, totalTokens + 10)).toBe("");
    expect(sliceText(MULTI_TOKEN_WORDS, 0, totalTokens + 10)).toBe(
      MULTI_TOKEN_WORDS,
    );
    expect(sliceText(MULTI_TOKEN_WORDS, -1000)).toBe(MULTI_TOKEN_WORDS);
  });

  it("applies custom options to slice boundaries", () => {
    // Long ASCII words, so the default ratio governs rather than a language rule.
    const text = "Estimation heuristics approximate tokenizers";
    const defaultSlice = sliceText(text, 0, 3);
    const customSlice = sliceText(text, 0, 3, { defaultCharsPerToken: 2 });

    // With more tokens per text, the same token range covers less of it.
    expect(customSlice.length).toBeLessThan(defaultSlice.length);
  });
});

describe("splitByTokens", () => {
  it("splits text into chunks that reconstruct the input", () => {
    const chunks = splitText(SINGLE_TOKEN_WORDS, 5);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(SINGLE_TOKEN_WORDS);
  });

  it("repeats trailing tokens of a chunk at the start of the next when overlap is set", () => {
    const chunks = splitText("aaaa bbbb cccc dddd eeee", 2, { overlap: 1 });
    expect(chunks).toEqual([
      "aaaa bbbb",
      "bbbb cccc",
      "cccc dddd",
      "dddd eeee",
    ]);
  });

  it("returns an empty array for empty input", () => {
    expect(splitText("", 5)).toEqual([]);
  });

  it("returns an empty array for a non-positive target chunk size", () => {
    expect(splitText("text", 0)).toEqual([]);
    expect(splitText("text", -5)).toEqual([]);
  });

  it("returns a single chunk when the text is smaller than the target", () => {
    const shortText = "Hi there";
    expect(splitText(shortText, 100)).toEqual([shortText]);
  });

  it("exceeds the target when a single segment crosses it", () => {
    const longWord = "supercalifragilisticexpialidocious";

    expect(countText(longWord)).toBeGreaterThan(2);
    expect(splitText(longWord, 2)).toEqual([longWord]);
  });

  it("does not emit a trailing chunk containing only overlap content", () => {
    const chunks = splitText("aaaa bbbb cccc dddd", 2, { overlap: 1 });
    expect(chunks).toEqual(["aaaa bbbb", "bbbb cccc", "cccc dddd"]);
  });

  it("clamps overlap below the target chunk size", () => {
    const text = "aaaa bbbb cccc dddd eeee";
    const oversizedOverlapChunks = splitText(text, 2, { overlap: 5 });
    const clampedOverlapChunks = splitText(text, 2, { overlap: 1 });

    expect(oversizedOverlapChunks).toEqual(clampedOverlapChunks);
  });
});

describe("unaccentedWordScale", () => {
  const german =
    "Als Gregor Samsa eines Morgens aus unruhigen Träumen erwachte fand er sich in seinem Bett zu einem ungeheueren Ungeziefer verwandelt";
  const english =
    "As Gregor Samsa awoke one morning from uneasy dreams he found himself transformed in his bed into a gigantic insect.";

  it("scales the unaccented words of a text that the accent rule identifies", () => {
    // Without punctuation, every token but the accented word's is a scaled word.
    const scaled = { unaccentedWordScale: { german: 2 } };
    const accented = countText("Träumen");
    const plain = countText(german) - accented;
    expect(countText(german, scaled)).toBe(2 * plain + accented);
    // A text without accented words keeps its estimate.
    expect(countText(english, scaled)).toBe(countText(english));
  });

  it("applies the scale in proportion below 5% accented words", () => {
    // One accented word among 40 words: 2.5%, so half of the scale applies.
    const text = `${Array(39).fill("Haus").join(" ")} Träume`;
    const plain = countText(text) - countText("Träume");
    expect(countText(text, { unaccentedWordScale: { german: 3 } })).toBe(
      Math.round(2 * plain) + countText("Träume"),
    );
  });
});
