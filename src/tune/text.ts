import type { ResolvedTextProfile } from "../segments.ts";
import {
  DEFAULT_LANGUAGE_CONFIGS,
  getCharacterClass,
  isHangulCodePoint,
  PATTERNS,
  resolveTextProfile,
  resolveTokenEstimationOptions,
  TEXT_PROFILE_FIELDS,
  walkSegments,
} from "../segments.ts";
import type { LanguageId, TextProfile } from "../types.ts";

export const TEXT_FIELDS = TEXT_PROFILE_FIELDS.filter(
  (field) => field !== "languageCharsPerToken",
) as readonly Exclude<keyof ResolvedTextProfile, "languageCharsPerToken">[];

export const LANGUAGES: readonly LanguageId[] = DEFAULT_LANGUAGE_CONFIGS.map(
  (config) => config.id,
);

export type ResolvedText = ResolvedTextProfile;

export type Rule =
  | { kind: "word"; length: number; lowercase: boolean }
  | { kind: "digits" | "punctuation"; length: number }
  | { kind: "language"; length: number; language: LanguageId }
  | { kind: "cjk"; hanzi: number; kana: number; hangul: number };

export interface TextHistogram {
  fixed: number;
  rules: Map<string, { rule: Rule; count: number }>;
}

export function resolveTextRules(text?: TextProfile): ResolvedText {
  return resolveTextProfile(text);
}

export function createHistogram(): TextHistogram {
  return { fixed: 0, rules: new Map() };
}

/** The shared scanner establishes boundaries and whitespace costs once. */
export function buildHistogram(text: string): TextHistogram {
  const histogram = createHistogram();
  for (const { segment, tokenCount } of walkSegments(
    text,
    resolveTokenEstimationOptions(),
  )) {
    const characterClass = getCharacterClass(segment.charCodeAt(0));
    if (characterClass === 2) {
      histogram.fixed += tokenCount;
      continue;
    }

    let rule: Rule;
    if (characterClass === 1) {
      rule = { kind: "punctuation", length: segment.length };
    } else {
      const language = PATTERNS.nonAscii.test(segment)
        ? DEFAULT_LANGUAGE_CONFIGS.find(
            (config) => segment.search(config.pattern) !== -1,
          )?.id
        : undefined;
      if (language) {
        rule = { kind: "language", length: [...segment].length, language };
      } else if (PATTERNS.cjk.test(segment)) {
        let hanzi = 0;
        let kana = 0;
        let hangul = 0;
        for (const character of segment) {
          const code = character.codePointAt(0)!;
          if (code >= 0x3040 && code <= 0x30ff) kana++;
          else if (isHangulCodePoint(code)) hangul++;
          else hanzi++;
        }
        rule = { kind: "cjk", hanzi, kana, hangul };
      } else if (PATTERNS.numeric.test(segment)) {
        rule = { kind: "digits", length: segment.length };
      } else {
        rule = {
          kind: "word",
          length: segment.length,
          lowercase: PATTERNS.lowercaseWord.test(segment),
        };
      }
    }
    const key = JSON.stringify(rule);
    const entry = histogram.rules.get(key);
    if (entry) entry.count++;
    else histogram.rules.set(key, { rule, count: 1 });
  }
  return histogram;
}

export function mergeHistogram(
  target: TextHistogram,
  source: TextHistogram,
): void {
  target.fixed += source.fixed;
  for (const [key, entry] of source.rules) {
    const existing = target.rules.get(key);
    if (existing) existing.count += entry.count;
    else target.rules.set(key, { rule: entry.rule, count: entry.count });
  }
}

export function estimateHistogramTokens(
  histogram: TextHistogram,
  text: ResolvedText,
): number {
  let total = histogram.fixed;
  for (const { rule, count } of histogram.rules.values()) {
    let tokens: number;
    switch (rule.kind) {
      case "word":
        tokens =
          rule.length <= text.shortTokenThreshold ||
          (rule.lowercase && rule.length <= text.lowercaseWordMaxLength)
            ? 1
            : Math.ceil(rule.length / text.defaultCharsPerToken);
        break;
      case "digits":
        tokens = Math.ceil(rule.length / text.digitsPerToken);
        break;
      case "punctuation":
        tokens =
          rule.length <= text.shortTokenThreshold
            ? 1
            : Math.ceil(rule.length / text.punctuationCharsPerToken);
        break;
      case "language":
        tokens = Math.ceil(
          rule.length / text.languageCharsPerToken[rule.language],
        );
        break;
      case "cjk":
        tokens = Math.ceil(
          rule.hanzi / text.hanziCharsPerToken +
            rule.kana / text.kanaCharsPerToken +
            rule.hangul / text.hangulCharsPerToken,
        );
        break;
    }
    total += tokens * count;
  }
  return total;
}

export type TextField =
  | keyof Omit<ResolvedText, "languageCharsPerToken">
  | LanguageId;

export const ALL_TEXT_FIELDS: readonly TextField[] = [
  ...TEXT_FIELDS,
  ...LANGUAGES,
];

export function getTextValue(text: ResolvedText, field: TextField): number {
  return LANGUAGES.includes(field as LanguageId)
    ? text.languageCharsPerToken[field as LanguageId]
    : text[field as keyof Omit<ResolvedText, "languageCharsPerToken">];
}

export function setTextValue(
  text: ResolvedText,
  field: TextField,
  value: number,
): void {
  if (LANGUAGES.includes(field as LanguageId))
    text.languageCharsPerToken[field as LanguageId] = value;
  else text[field as keyof Omit<ResolvedText, "languageCharsPerToken">] = value;
}

export function containsTextField(
  histogram: TextHistogram,
  field: TextField,
): boolean {
  for (const { rule } of histogram.rules.values()) {
    if (rule.kind === "language" && rule.language === field) return true;
    if (
      rule.kind === "cjk" &&
      ((field === "hanziCharsPerToken" && rule.hanzi > 0) ||
        (field === "kanaCharsPerToken" && rule.kana > 0) ||
        (field === "hangulCharsPerToken" && rule.hangul > 0))
    )
      return true;
    if (
      rule.kind === "word" &&
      (field === "defaultCharsPerToken" ||
        field === "shortTokenThreshold" ||
        (field === "lowercaseWordMaxLength" && rule.lowercase))
    )
      return true;
    if (
      rule.kind === "punctuation" &&
      (field === "punctuationCharsPerToken" || field === "shortTokenThreshold")
    )
      return true;
    if (rule.kind === "digits" && field === "digitsPerToken") return true;
  }
  return false;
}
