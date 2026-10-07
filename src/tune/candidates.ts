import type { ResolvedText, Rule, TextField, TextHistogram } from "./text.ts";
import { getTextValue } from "./text.ts";

// A byte-level tokenizer emits at most one token per UTF-8 byte, so a ratio
// is at least 1 / bytes per character: 1 for ASCII and mostly-ASCII accented
// words, 1/2 for Cyrillic and Greek, 1/3 for CJK, and 1/4 for emoji.
const MINIMUM_RATIO: Partial<Record<TextField, number>> = {
  cyrillic: 1 / 2,
  greek: 1 / 2,
  hanziCharsPerToken: 1 / 3,
  kanaCharsPerToken: 1 / 3,
  hangulCharsPerToken: 1 / 3,
  emoji: 1 / 4,
};

/** Ceil(n / ratio + offset) changes only at n / (integer - offset), searched between the minimum ratio and 20. */
export function listCandidateValues(
  field: TextField,
  histograms: readonly TextHistogram[],
  text: ResolvedText,
  original: number,
): number[] {
  if (field === "shortTokenThreshold" || field === "lowercaseWordMaxLength")
    return [
      ...Array.from(
        { length: field === "shortTokenThreshold" ? 17 : 25 },
        (_, n) => n,
      ),
      original,
    ];
  const minimum = MINIMUM_RATIO[field] ?? 1;
  const maximum = 20;
  const boundaries = new Set<number>([minimum, maximum]);
  const terms = new Set<string>();
  for (const histogram of histograms) {
    for (const { rule } of histogram.rules.values()) {
      const [length, offset] = getChangingTerm(rule, field, text);
      if (!length || terms.has(`${length}:${offset}`)) continue;
      terms.add(`${length}:${offset}`);
      for (
        let tokens = Math.ceil(length / maximum + offset);
        tokens <= Math.floor(length / minimum + offset);
        tokens++
      ) {
        const boundary = length / (tokens - offset);
        if (
          Number.isFinite(boundary) &&
          boundary >= minimum &&
          boundary <= maximum
        )
          boundaries.add(boundary);
      }
    }
  }
  const sorted = [...boundaries].sort((a, b) => a - b);
  const candidates = [...sorted, original, getTextValue(text, field)];
  for (let n = 1; n < sorted.length; n++) {
    const lower = sorted[n - 1]!;
    const upper = sorted[n]!;
    const margin = Math.max(Number.EPSILON * upper * 8, (upper - lower) * 1e-8);
    candidates.push(
      Math.max(lower + margin, Math.min(upper - margin, original)),
    );
  }
  return candidates;
}

function getChangingTerm(
  rule: Rule,
  field: TextField,
  text: ResolvedText,
): [number, number] {
  switch (rule.kind) {
    case "word":
      return field === "defaultCharsPerToken" &&
        rule.length > text.shortTokenThreshold &&
        !(rule.lowercase && rule.length <= text.lowercaseWordMaxLength)
        ? [rule.length, 0]
        : [0, 0];
    case "punctuation":
      return field === "punctuationCharsPerToken" &&
        rule.length > text.shortTokenThreshold
        ? [rule.length, 0]
        : [0, 0];
    case "digits":
      return field === "digitsPerToken" ? [rule.length, 0] : [0, 0];
    case "language":
      return field === rule.language ? [rule.length, 0] : [0, 0];
    case "cjk":
      if (field === "hanziCharsPerToken")
        return [
          rule.hanzi,
          rule.kana / text.kanaCharsPerToken +
            rule.hangul / text.hangulCharsPerToken,
        ];
      if (field === "kanaCharsPerToken")
        return [
          rule.kana,
          rule.hanzi / text.hanziCharsPerToken +
            rule.hangul / text.hangulCharsPerToken,
        ];
      if (field === "hangulCharsPerToken")
        return [
          rule.hangul,
          rule.hanzi / text.hanziCharsPerToken +
            rule.kana / text.kanaCharsPerToken,
        ];
      return [0, 0];
  }
}
