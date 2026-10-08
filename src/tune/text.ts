import type { ResolvedTextProfile } from "../segments.ts";
import {
  ACCENT_LANGUAGES,
  DEFAULT_LANGUAGE_CONFIGS,
  getCharacterClass,
  isHangulCodePoint,
  isInnerUnderscore,
  measureAccentWeights,
  PATTERNS,
  resolveTextProfile,
  resolveTokenEstimationOptions,
  TEXT_PROFILE_FIELDS,
  walkSegments,
} from "../segments.ts";
import type { AccentLanguageId, LanguageId, TextProfile } from "../types.ts";

type ScalarTextField = Exclude<
  keyof ResolvedTextProfile,
  "languageCharsPerToken" | "unaccentedWordScale"
>;

const TEXT_FIELDS = TEXT_PROFILE_FIELDS.filter(
  (field) =>
    field !== "languageCharsPerToken" && field !== "unaccentedWordScale",
) as readonly ScalarTextField[];

export const LANGUAGES: readonly LanguageId[] = DEFAULT_LANGUAGE_CONFIGS.map(
  (config) => config.id,
);

export type ResolvedText = ResolvedTextProfile;

export type Rule =
  | {
      kind: "word";
      length: number;
      lowercase: boolean;
      /** For unaccented ASCII words: the accent weights of their text, when any is nonzero. */
      weights?: number[];
    }
  | { kind: "digits" | "punctuation"; length: number }
  | { kind: "underscore" }
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
  const accentWeights = measureAccentWeights(text);
  const weights = accentWeights.some(Boolean) ? accentWeights : undefined;
  let offset = 0;
  for (const { segment, tokenCount } of walkSegments(
    text,
    resolveTokenEstimationOptions(),
  )) {
    const start = offset;
    offset += segment.length;
    const characterClass = getCharacterClass(segment.charCodeAt(0));
    if (characterClass === 2) {
      histogram.fixed += tokenCount;
      continue;
    }

    let rule: Rule;
    if (characterClass === 1) {
      rule = isInnerUnderscore(text, start, offset)
        ? { kind: "underscore" }
        : { kind: "punctuation", length: segment.length };
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
          ...(weights && !PATTERNS.nonAscii.test(segment) ? { weights } : {}),
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
        if (rule.weights)
          tokens *= ACCENT_LANGUAGES.reduce(
            (scale, id, index) =>
              scale +
              rule.weights![index]! * (text.unaccentedWordScale[id] - 1),
            1,
          );
        break;
      case "digits":
        tokens = Math.ceil(rule.length / text.digitsPerToken);
        break;
      case "underscore":
        tokens = text.innerUnderscoreTokens;
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

/** A scale of unaccented words; fitted on running text only. */
export type ScaleField = `unaccentedWordScale.${AccentLanguageId}`;

export type TextField = ScalarTextField | LanguageId | ScaleField;

export const SCALE_FIELDS: readonly ScaleField[] = ACCENT_LANGUAGES.map(
  (id) => `unaccentedWordScale.${id}` as const,
);

export const ALL_TEXT_FIELDS: readonly TextField[] = [
  ...TEXT_FIELDS,
  ...LANGUAGES,
  ...SCALE_FIELDS,
];

const scaleLanguage = (field: TextField): AccentLanguageId | undefined =>
  field.startsWith("unaccentedWordScale.")
    ? (field.slice("unaccentedWordScale.".length) as AccentLanguageId)
    : undefined;

export function getTextValue(text: ResolvedText, field: TextField): number {
  const scaled = scaleLanguage(field);
  if (scaled) return text.unaccentedWordScale[scaled];
  return LANGUAGES.includes(field as LanguageId)
    ? text.languageCharsPerToken[field as LanguageId]
    : text[field as ScalarTextField];
}

export function setTextValue(
  text: ResolvedText,
  field: TextField,
  value: number,
): void {
  const scaled = scaleLanguage(field);
  if (scaled) text.unaccentedWordScale[scaled] = value;
  else if (LANGUAGES.includes(field as LanguageId))
    text.languageCharsPerToken[field as LanguageId] = value;
  else text[field as ScalarTextField] = value;
}

/** The name of a text field in reports, for example `text.languageCharsPerToken.german`. */
export function getTextFieldName(field: TextField): `text.${string}` {
  return `text.${LANGUAGES.includes(field as LanguageId) ? `languageCharsPerToken.${field}` : field}`;
}

export function containsTextField(
  histogram: TextHistogram,
  field: TextField,
): boolean {
  const scaled = scaleLanguage(field);
  for (const { rule } of histogram.rules.values()) {
    if (scaled)
      if (
        rule.kind === "word" &&
        rule.weights?.[ACCENT_LANGUAGES.indexOf(scaled)]
      )
        return true;
      else continue;
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
    if (rule.kind === "underscore" && field === "innerUnderscoreTokens")
      return true;
  }
  return false;
}
