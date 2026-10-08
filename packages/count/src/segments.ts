import { selectProfile } from "./profiles.ts";
import type {
  AccentLanguageId,
  LanguageConfig,
  LanguageId,
  TextProfile,
  TokenEstimationOptions,
} from "./types.ts";

export const PATTERNS: Readonly<
  Record<"nonAscii" | "cjk" | "numeric" | "lowercaseWord", RegExp>
> = {
  nonAscii: /[\u0080-\uFFFF]/,
  cjk: /[\u4E00-\u9FFF\u3400-\u4DBF\u3000-\u30FF\uFF00-\uFFEF\u2E80-\u2EFF\u31C0-\u31EF\u3200-\u32FF\u3300-\u33FF\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F\uA960-\uA97F\uD7B0-\uD7FF]/,
  numeric: /^\d+$/,
  lowercaseWord: /^[a-z]+$/,
} as const;

// The punctuation characters, all ASCII. A run of them is one segment.
const PUNCTUATION_CHARACTERS = '.,!?;(){}[]<>:/\\|@#$%^&*+=`~_"-';

// Character classes of the scanner.
// The low two bits give the class; word characters also carry flags, so
// one AND per character tracks whether a word is all digits or all lowercase.
const WORD = 0;
const PUNCTUATION = 1;
const WHITESPACE = 2;
const CLASS_MASK = 3;
const DIGIT_FLAG = 4;
const LOWERCASE_FLAG = 8;

const LINE_FEED = 0x0a;

const ASCII_CHARACTER_CLASSES = new Uint8Array(128);
for (const character of PUNCTUATION_CHARACTERS)
  ASCII_CHARACTER_CLASSES[character.charCodeAt(0)] = PUNCTUATION;
for (const character of "\t\n\v\f\r ")
  ASCII_CHARACTER_CLASSES[character.charCodeAt(0)] = WHITESPACE;
for (let code = 0x30; code <= 0x39; code++)
  ASCII_CHARACTER_CLASSES[code] = DIGIT_FLAG;
for (let code = 0x61; code <= 0x7a; code++)
  ASCII_CHARACTER_CLASSES[code] = LOWERCASE_FLAG;

/** A text profile with every field set. */
export type ResolvedTextProfile = Required<
  Omit<TextProfile, "languageCharsPerToken" | "unaccentedWordScale">
> & {
  languageCharsPerToken: Record<LanguageId, number>;
  unaccentedWordScale: Record<AccentLanguageId, number>;
};

/** The built-in text rules, calibrated against OpenAI's o200k_base encoding. */
export const DEFAULT_TEXT_PROFILE: Readonly<ResolvedTextProfile> =
  Object.freeze({
    defaultCharsPerToken: 7,
    punctuationCharsPerToken: 6,
    // o200k chunks digit runs into groups of up to three digits.
    digitsPerToken: 3,
    shortTokenThreshold: 3,
    lowercaseWordMaxLength: 8,
    innerUnderscoreTokens: 0,
    hanziCharsPerToken: 1.15,
    kanaCharsPerToken: 1.4,
    hangulCharsPerToken: 1.65,
    languageCharsPerToken: Object.freeze({
      german: 3,
      romance: 4.5,
      slavicLatin: 2.5,
      cyrillic: 6,
      greek: 3,
      emoji: 0.9,
    }),
    unaccentedWordScale: Object.freeze({
      german: 1,
      romance: 1,
      slavicLatin: 1,
    }),
  });

/** Every field of a text profile. */
export const TEXT_PROFILE_FIELDS = Object.keys(
  DEFAULT_TEXT_PROFILE,
) as readonly (keyof TextProfile & keyof ResolvedTextProfile)[];

/**
 * Fills every missing text field from `DEFAULT_TEXT_PROFILE`. Later profiles
 * override earlier ones field by field, and language ratios and scales merge
 * one level deep.
 */
export function resolveTextProfile(
  ...profiles: (TextProfile | undefined)[]
): ResolvedTextProfile {
  const resolved = {
    ...DEFAULT_TEXT_PROFILE,
    languageCharsPerToken: { ...DEFAULT_TEXT_PROFILE.languageCharsPerToken },
    unaccentedWordScale: { ...DEFAULT_TEXT_PROFILE.unaccentedWordScale },
  } as ResolvedTextProfile;
  for (const profile of profiles) {
    for (const field of TEXT_PROFILE_FIELDS) {
      const value = profile?.[field];
      if (value === undefined) continue;
      if (field !== "languageCharsPerToken" && field !== "unaccentedWordScale")
        resolved[field] = value as number;
      else
        for (const [id, number] of Object.entries(value as object))
          if (number !== undefined)
            (resolved[field] as Record<string, number>)[id] = number;
    }
  }
  return resolved;
}

const {
  languageCharsPerToken: DEFAULT_LANGUAGE_RATIOS,
  unaccentedWordScale: _defaultScales,
  ...DEFAULT_RATIOS
} = DEFAULT_TEXT_PROFILE;

interface DefaultLanguageConfig extends LanguageConfig {
  id: LanguageId;
}

export const DEFAULT_LANGUAGE_CONFIGS: DefaultLanguageConfig[] = [
  // An accent rule prices a whole language through the minority of its words
  // that carry an accent, so each ratio is fitted against running text in that
  // language rather than against the segments the pattern matches.
  {
    id: "german",
    pattern: /[äöüßẞ]/i,
    averageCharsPerToken: DEFAULT_LANGUAGE_RATIOS.german,
  },
  {
    id: "romance",
    pattern: /[éèêëàâîïôûùüÿçœæáíóúñ]/i,
    averageCharsPerToken: DEFAULT_LANGUAGE_RATIOS.romance,
  },
  // Set below what the accented segments alone would fit: unaccented Slavic
  // words fall through to the default ratio, and this compensates the shortfall.
  {
    id: "slavicLatin",
    pattern: /[ąćęłńóśźżěščřžýůúďťň]/i,
    averageCharsPerToken: DEFAULT_LANGUAGE_RATIOS.slavicLatin,
  },
  {
    id: "cyrillic",
    pattern: /[\u0430-\u044F\u0451]/i,
    averageCharsPerToken: DEFAULT_LANGUAGE_RATIOS.cyrillic,
  },
  {
    id: "greek",
    pattern: /[\u03AC-\u03CE]/i,
    averageCharsPerToken: DEFAULT_LANGUAGE_RATIOS.greek,
  },
  // Anchored to pure emoji runs – symbols like ™ are Extended_Pictographic
  // too, and an unanchored match would misprice the whole attached word.
  {
    id: "emoji",
    pattern:
      /^\p{Extended_Pictographic}[\p{Extended_Pictographic}\p{Emoji_Component}]*$/u,
    averageCharsPerToken: DEFAULT_LANGUAGE_RATIOS.emoji,
  },
];

export interface SegmentEstimate {
  segment: string;
  tokenCount: number;
}

/** Text options with every default filled in. Resolve once and reuse for repeated estimates. */
export interface ResolvedTokenEstimationOptions
  extends Omit<
    ResolvedTextProfile,
    "languageCharsPerToken" | "unaccentedWordScale"
  > {
  contentMultiplier: number;
  languageConfigs: LanguageConfig[];
  /** Set when every language config needs a non-ASCII character to match. */
  languageConfigsNeedNonAscii: boolean;
  /** The scales of unaccented words, in `ACCENT_LANGUAGES` order; absent when all are 1. */
  unaccentedWordScale?: readonly number[];
  /** Estimates of the words that need the slow path, which repeat often in running text. */
  segmentCache?: Map<string, number>;
}

const DEFAULT_RESOLVED_OPTIONS: ResolvedTokenEstimationOptions = {
  contentMultiplier: 1,
  ...DEFAULT_RATIOS,
  languageConfigs: DEFAULT_LANGUAGE_CONFIGS,
  languageConfigsNeedNonAscii: true,
  segmentCache: new Map(),
};

const UNCACHED_DEFAULT_OPTIONS: ResolvedTokenEstimationOptions = {
  ...DEFAULT_RESOLVED_OPTIONS,
  segmentCache: undefined,
};

export function resolveTokenEstimationOptions(
  options: TokenEstimationOptions = {},
): ResolvedTokenEstimationOptions {
  const profile = selectProfile(options.profile);
  if (
    profile === undefined &&
    options.languageConfigs === undefined &&
    TEXT_PROFILE_FIELDS.every((field) => options[field] === undefined)
  ) {
    return options.cache === false
      ? UNCACHED_DEFAULT_OPTIONS
      : DEFAULT_RESOLVED_OPTIONS;
  }

  // Direct options override the profile's text rules, which override the defaults.
  const { languageCharsPerToken, unaccentedWordScale, ...ratios } =
    resolveTextProfile(profile?.text, options);
  const scales = ACCENT_LANGUAGES.map((id) => unaccentedWordScale[id]);
  return {
    contentMultiplier: profile?.contentMultiplier ?? 1,
    ...ratios,
    languageConfigs:
      options.languageConfigs ??
      DEFAULT_LANGUAGE_CONFIGS.map((config) => ({
        id: config.id,
        pattern: config.pattern,
        averageCharsPerToken: languageCharsPerToken[config.id],
      })),
    // Custom configs carry no guarantee that they need a non-ASCII character.
    languageConfigsNeedNonAscii: options.languageConfigs === undefined,
    // The scales belong to the built-in accent rules.
    ...(options.languageConfigs === undefined &&
    scales.some((scale) => scale !== 1)
      ? { unaccentedWordScale: scales }
      : {}),
    segmentCache: options.cache === false ? undefined : new Map(),
  };
}

/** Sums the token estimates of all segments of a text, without one allocation per segment. */
export function countTextTokens(
  text: string,
  options: ResolvedTokenEstimationOptions,
): number {
  if (!text) return 0;

  const scanner = new SegmentScanner(text, options);
  let tokenCount = 0;
  while (scanner.next()) tokenCount += scanner.tokenCount;

  return Math.round(tokenCount * options.contentMultiplier);
}

/**
 * Walks a text as (segment, estimated token count) pairs. The segments
 * concatenate back to the original text; whitespace segments count zero
 * tokens unless they carry structure (indentation or blank lines).
 */
export function* walkSegments(
  text: string,
  options: ResolvedTokenEstimationOptions,
): Generator<SegmentEstimate> {
  if (!text) return;

  const scanner = new SegmentScanner(text, options);
  while (scanner.next())
    yield {
      segment: text.slice(scanner.start, scanner.end),
      tokenCount: scanner.tokenCount * options.contentMultiplier,
    };
}

/**
 * Splits a text into maximal runs of whitespace, of punctuation, and of all
 * other characters (words), and prices each run. A scan over character codes
 * replaces a regex split: ASCII words need no substring and no regex test.
 */
class SegmentScanner {
  start = 0;
  end = 0;
  tokenCount = 0;
  private previousIsPunctuation = false;
  private readonly text: string;
  private readonly options: ResolvedTokenEstimationOptions;
  private readonly wordScale: number;

  constructor(text: string, options: ResolvedTokenEstimationOptions) {
    this.text = text;
    this.options = options;
    this.wordScale = getUnaccentedWordScale(text, options);
  }

  next(): boolean {
    const { text, options } = this;
    const length = text.length;
    let index = this.end;
    if (index >= length) return false;

    this.start = index;
    const characterClass = getCharacterClass(text.charCodeAt(index));

    if (characterClass === WHITESPACE) {
      let lineBreakIndex = -1;
      while (index < length) {
        const code = text.charCodeAt(index);
        if (getCharacterClass(code) !== WHITESPACE) break;
        if (code === LINE_FEED && lineBreakIndex === -1) lineBreakIndex = index;
        index++;
      }

      if (lineBreakIndex === -1) {
        this.tokenCount = 0;
      }
      // The run is all whitespace, so a line break before its last character
      // is followed by more whitespace: indentation and blank lines cost a
      // token in o200k.
      else if (lineBreakIndex < index - 1) {
        this.tokenCount = 1;
      }
      // A line break merges into a preceding punctuation token but stands on
      // its own after a word. Single spaces always merge.
      else {
        this.tokenCount = this.previousIsPunctuation ? 0 : 1;
      }
      this.previousIsPunctuation = false;
    } else if (characterClass === PUNCTUATION) {
      while (
        index < length &&
        getCharacterClass(text.charCodeAt(index)) === PUNCTUATION
      )
        index++;

      this.tokenCount = isInnerUnderscore(text, this.start, index)
        ? options.innerUnderscoreTokens
        : options.languageConfigsNeedNonAscii
          ? estimatePunctuationRunTokens(index - this.start, options)
          : estimateSegmentTokens(text.slice(this.start, index), true, options);
      this.previousIsPunctuation = true;
    } else {
      let hasNonAscii = false;
      let flags = DIGIT_FLAG | LOWERCASE_FLAG;
      while (index < length) {
        const code = text.charCodeAt(index);
        if (code < 128) {
          const entry = ASCII_CHARACTER_CLASSES[code]!;
          if ((entry & CLASS_MASK) !== WORD) break;
          flags &= entry;
        } else {
          if (isNonAsciiWhitespace(code)) break;
          hasNonAscii = true;
        }
        index++;
      }
      const isNumeric = (flags & DIGIT_FLAG) !== 0;
      const isLowercase = (flags & LOWERCASE_FLAG) !== 0;

      this.tokenCount =
        hasNonAscii || !options.languageConfigsNeedNonAscii
          ? estimateWordTokens(text.slice(this.start, index), options)
          : estimateAsciiWordTokens(
              index - this.start,
              isNumeric,
              isLowercase,
              options,
            ) * (isNumeric ? 1 : this.wordScale);
      this.previousIsPunctuation = false;
    }

    this.end = index;
    return true;
  }
}

/** The built-in accent rules, in the order of their scales. */
export const ACCENT_LANGUAGES: readonly AccentLanguageId[] = [
  "german",
  "romance",
  "slavicLatin",
];

// Natural German, French, Spanish and Polish prose has 10–15% accented words
// or more; English with a few loanwords has less than 1%. From this share up,
// the scale of a language applies in full.
const FULL_SCALE_ACCENT_SHARE = 0.05;

// A word segment: a run of characters that are not whitespace or punctuation.
const WORD_PATTERN = /[^\s.,!?;(){}[\]<>:/\\|@#$%^&*+=`~_"-]+/g;

/**
 * The weight of each accent language in a text, in `ACCENT_LANGUAGES` order:
 * the share of its words that the accent rule matches, divided by
 * `FULL_SCALE_ACCENT_SHARE` and capped at 1. Shares count unaccented ASCII
 * words and words that an accent rule matches.
 */
export function measureAccentWeights(text: string): number[] {
  const matches = [0, 0, 0];
  if (!PATTERNS.nonAscii.test(text)) return matches;
  let words = 0;
  for (const [word] of text.matchAll(WORD_PATTERN)) {
    if (!PATTERNS.nonAscii.test(word)) {
      if (!PATTERNS.numeric.test(word)) words++;
      continue;
    }
    const config = DEFAULT_LANGUAGE_CONFIGS.find(
      (candidate) => word.search(candidate.pattern) !== -1,
    );
    const index = config
      ? ACCENT_LANGUAGES.indexOf(config.id as AccentLanguageId)
      : -1;
    if (index === -1) continue;
    matches[index]!++;
    words++;
  }
  return matches.map((count) =>
    Math.min(1, count / words / FULL_SCALE_ACCENT_SHARE),
  );
}

/** The factor of the unaccented ASCII words in a text. */
function getUnaccentedWordScale(
  text: string,
  options: ResolvedTokenEstimationOptions,
): number {
  const scales = options.unaccentedWordScale;
  if (!scales || !PATTERNS.nonAscii.test(text)) return 1;
  const weights = measureAccentWeights(text);
  let scale = 1;
  for (let index = 0; index < scales.length; index++)
    scale += weights[index]! * (scales[index]! - 1);
  return scale;
}

const UNDERSCORE = 0x5f;

/**
 * Whether the run from `start` to `end` is one underscore between a word and
 * a letter, as in `snake_case`. Before a digit, o200k keeps it apart.
 */
export function isInnerUnderscore(
  text: string,
  start: number,
  end: number,
): boolean {
  if (
    end - start !== 1 ||
    text.charCodeAt(start) !== UNDERSCORE ||
    start === 0 ||
    end >= text.length ||
    getCharacterClass(text.charCodeAt(start - 1)) !== WORD
  )
    return false;
  const next = text.charCodeAt(end);
  return next >= 128
    ? getCharacterClass(next) === WORD
    : (ASCII_CHARACTER_CLASSES[next]! & (DIGIT_FLAG | CLASS_MASK)) === WORD;
}

export function getCharacterClass(code: number): number {
  if (code < 128) return ASCII_CHARACTER_CLASSES[code]! & CLASS_MASK;
  return isNonAsciiWhitespace(code) ? WHITESPACE : WORD;
}

/** The non-ASCII characters that `\s` matches. */
function isNonAsciiWhitespace(code: number): boolean {
  return (
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

function estimateAsciiWordTokens(
  length: number,
  isNumeric: boolean,
  isLowercase: boolean,
  options: ResolvedTokenEstimationOptions,
): number {
  if (isNumeric) return Math.ceil(length / options.digitsPerToken);
  if (length <= options.shortTokenThreshold) return 1;
  // o200k merges common lowercase words of up to eight characters into a
  // single token. The lowercase gate keeps capitalized compounds and scripts
  // without a built-in rule at the default ratio.
  if (isLowercase && length <= options.lowercaseWordMaxLength) return 1;
  return Math.ceil(length / options.defaultCharsPerToken);
}

// Bounds the memory of the segment cache. A full cache starts again empty.
const MAX_CACHED_SEGMENTS = 8192;

function estimateWordTokens(
  segment: string,
  options: ResolvedTokenEstimationOptions,
): number {
  const cache = options.segmentCache;
  if (!cache) return estimateSegmentTokens(segment, false, options);
  let tokenCount = cache.get(segment);
  if (tokenCount === undefined) {
    tokenCount = estimateSegmentTokens(segment, false, options);
    if (cache.size >= MAX_CACHED_SEGMENTS) cache.clear();
    cache.set(segment, tokenCount);
  }
  return tokenCount;
}

function estimatePunctuationRunTokens(
  length: number,
  options: ResolvedTokenEstimationOptions,
): number {
  if (length <= options.shortTokenThreshold) return 1;
  return Math.ceil(length / options.punctuationCharsPerToken);
}

/** Prices a word or punctuation run that may match a language config. */
function estimateSegmentTokens(
  segment: string,
  isPunctuation: boolean,
  options: ResolvedTokenEstimationOptions,
): number {
  // Checked before the built-in rules so custom configs can override them.
  // Punctuation is ASCII, so it can only match a custom config.
  const hasNonAscii = !isPunctuation && PATTERNS.nonAscii.test(segment);
  if (hasNonAscii || !options.languageConfigsNeedNonAscii) {
    const languageCharsPerToken = getLanguageSpecificCharsPerToken(
      segment,
      options.languageConfigs,
    );
    if (languageCharsPerToken !== undefined) {
      return Math.ceil(getCharacterCount(segment) / languageCharsPerToken);
    }
  }

  if (hasNonAscii && PATTERNS.cjk.test(segment)) {
    return estimateCjkTokens(segment, options);
  }

  if (isPunctuation)
    return estimatePunctuationRunTokens(segment.length, options);

  return estimateAsciiWordTokens(
    segment.length,
    PATTERNS.numeric.test(segment),
    PATTERNS.lowercaseWord.test(segment),
    options,
  );
}

function getLanguageSpecificCharsPerToken(
  segment: string,
  languageConfigs: LanguageConfig[],
): number | undefined {
  for (const config of languageConfigs) {
    // `search` instead of `test`: it ignores `lastIndex`, so stateful flags
    // (`/g`, `/y`) on user-supplied patterns can't skew matching.
    if (segment.search(config.pattern) !== -1) {
      return config.averageCharsPerToken;
    }
  }
}

function getCharacterCount(text: string): number {
  return Array.from(text).length;
}

function estimateCjkTokens(
  segment: string,
  options: ResolvedTokenEstimationOptions,
): number {
  let kanaCount = 0;
  let hangulCount = 0;
  let hanziCount = 0;

  for (const character of segment) {
    const codePoint = character.codePointAt(0)!;

    if (codePoint >= 0x3040 && codePoint <= 0x30ff) kanaCount++;
    else if (isHangulCodePoint(codePoint)) hangulCount++;
    else hanziCount++;
  }

  // One rounding for the whole segment: rounding each script on its own would
  // charge a token for every script boundary in mixed CJK text.
  return Math.ceil(
    hanziCount / options.hanziCharsPerToken +
      kanaCount / options.kanaCharsPerToken +
      hangulCount / options.hangulCharsPerToken,
  );
}

export function isHangulCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0xac00 && codePoint <= 0xd7af) ||
    (codePoint >= 0x1100 && codePoint <= 0x11ff) ||
    (codePoint >= 0x3130 && codePoint <= 0x318f) ||
    (codePoint >= 0xa960 && codePoint <= 0xa97f) ||
    (codePoint >= 0xd7b0 && codePoint <= 0xd7ff)
  );
}
