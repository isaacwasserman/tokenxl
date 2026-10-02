import type { LanguageConfig, LanguageId, TokenEstimationOptions } from './types.ts'

const PATTERNS = {
  nonAscii: /[\u0080-\uFFFF]/,
  cjk: /[\u4E00-\u9FFF\u3400-\u4DBF\u3000-\u30FF\uFF00-\uFFEF\u2E80-\u2EFF\u31C0-\u31EF\u3200-\u32FF\u3300-\u33FF\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F\uA960-\uA97F\uD7B0-\uD7FF]/,
  numeric: /^\d+$/,
  lowercaseWord: /^[a-z]+$/,
} as const

// The punctuation characters, all ASCII. A run of them is one segment.
const PUNCTUATION_CHARACTERS = '.,!?;(){}[]<>:/\\|@#$%^&*+=`~_"-'

// Character classes of the scanner.
// The low two bits give the class; word characters also carry flags, so
// one AND per character tracks whether a word is all digits or all lowercase.
const WORD = 0
const PUNCTUATION = 1
const WHITESPACE = 2
const CLASS_MASK = 3
const DIGIT_FLAG = 4
const LOWERCASE_FLAG = 8

const LINE_FEED = 0x0A

const ASCII_CHARACTER_CLASSES = new Uint8Array(128)
for (const character of PUNCTUATION_CHARACTERS)
  ASCII_CHARACTER_CLASSES[character.charCodeAt(0)] = PUNCTUATION
for (const character of '\t\n\v\f\r ')
  ASCII_CHARACTER_CLASSES[character.charCodeAt(0)] = WHITESPACE
for (let code = 0x30; code <= 0x39; code++)
  ASCII_CHARACTER_CLASSES[code] = DIGIT_FLAG
for (let code = 0x61; code <= 0x7A; code++)
  ASCII_CHARACTER_CLASSES[code] = LOWERCASE_FLAG

// All ratios are calibrated against OpenAI's o200k_base encoding.
const DEFAULT_CHARS_PER_TOKEN = 7
const SHORT_TOKEN_THRESHOLD = 3
const LOWERCASE_WORD_SINGLE_TOKEN_LENGTH = 8
const PUNCTUATION_CHARS_PER_TOKEN = 6
// o200k chunks digit runs into groups of up to three digits.
const DIGITS_PER_TOKEN = 3
const KANA_CHARS_PER_TOKEN = 1.4
const HANGUL_CHARS_PER_TOKEN = 1.65
const HANZI_CHARS_PER_TOKEN = 1.15

interface DefaultLanguageConfig extends LanguageConfig {
  id: LanguageId
}

const DEFAULT_LANGUAGE_CONFIGS: DefaultLanguageConfig[] = [
  // An accent rule prices a whole language through the minority of its words
  // that carry an accent, so each ratio is fitted against running text in that
  // language rather than against the segments the pattern matches.
  { id: 'german', pattern: /[äöüßẞ]/i, averageCharsPerToken: 3 },
  { id: 'romance', pattern: /[éèêëàâîïôûùüÿçœæáíóúñ]/i, averageCharsPerToken: 4.5 },
  // Set below what the accented segments alone would fit: unaccented Slavic
  // words fall through to the default ratio, and this compensates the shortfall.
  { id: 'slavicLatin', pattern: /[ąćęłńóśźżěščřžýůúďťň]/i, averageCharsPerToken: 2.5 },
  { id: 'cyrillic', pattern: /[\u0430-\u044F\u0451]/i, averageCharsPerToken: 6 },
  { id: 'greek', pattern: /[\u03AC-\u03CE]/i, averageCharsPerToken: 3 },
  // Anchored to pure emoji runs – symbols like ™ are Extended_Pictographic
  // too, and an unanchored match would misprice the whole attached word.
  { id: 'emoji', pattern: /^\p{Extended_Pictographic}[\p{Extended_Pictographic}\p{Emoji_Component}]*$/u, averageCharsPerToken: 0.9 },
]

export interface SegmentEstimate {
  segment: string
  tokenCount: number
}

/** Text options with every default filled in. Resolve once and reuse for repeated estimates. */
export interface ResolvedTokenEstimationOptions {
  defaultCharsPerToken: number
  punctuationCharsPerToken: number
  digitsPerToken: number
  shortTokenThreshold: number
  lowercaseWordMaxLength: number
  hanziCharsPerToken: number
  kanaCharsPerToken: number
  hangulCharsPerToken: number
  languageConfigs: LanguageConfig[]
  /** Set when every language config needs a non-ASCII character to match. */
  languageConfigsNeedNonAscii: boolean
  /** Estimates of the words that need the slow path, which repeat often in running text. */
  segmentCache: Map<string, number>
}

const DEFAULT_RESOLVED_OPTIONS: ResolvedTokenEstimationOptions = {
  defaultCharsPerToken: DEFAULT_CHARS_PER_TOKEN,
  punctuationCharsPerToken: PUNCTUATION_CHARS_PER_TOKEN,
  digitsPerToken: DIGITS_PER_TOKEN,
  shortTokenThreshold: SHORT_TOKEN_THRESHOLD,
  lowercaseWordMaxLength: LOWERCASE_WORD_SINGLE_TOKEN_LENGTH,
  hanziCharsPerToken: HANZI_CHARS_PER_TOKEN,
  kanaCharsPerToken: KANA_CHARS_PER_TOKEN,
  hangulCharsPerToken: HANGUL_CHARS_PER_TOKEN,
  languageConfigs: DEFAULT_LANGUAGE_CONFIGS,
  languageConfigsNeedNonAscii: true,
  segmentCache: new Map(),
}

export function resolveTokenEstimationOptions(options: TokenEstimationOptions = {}): ResolvedTokenEstimationOptions {
  const {
    defaultCharsPerToken,
    punctuationCharsPerToken,
    digitsPerToken,
    shortTokenThreshold,
    lowercaseWordMaxLength,
    hanziCharsPerToken,
    kanaCharsPerToken,
    hangulCharsPerToken,
    languageCharsPerToken,
    languageConfigs,
  } = options

  if (
    defaultCharsPerToken === undefined
    && punctuationCharsPerToken === undefined
    && digitsPerToken === undefined
    && shortTokenThreshold === undefined
    && lowercaseWordMaxLength === undefined
    && hanziCharsPerToken === undefined
    && kanaCharsPerToken === undefined
    && hangulCharsPerToken === undefined
    && languageCharsPerToken === undefined
    && languageConfigs === undefined
  ) {
    return DEFAULT_RESOLVED_OPTIONS
  }

  return {
    defaultCharsPerToken: defaultCharsPerToken ?? DEFAULT_CHARS_PER_TOKEN,
    punctuationCharsPerToken: punctuationCharsPerToken ?? PUNCTUATION_CHARS_PER_TOKEN,
    digitsPerToken: digitsPerToken ?? DIGITS_PER_TOKEN,
    shortTokenThreshold: shortTokenThreshold ?? SHORT_TOKEN_THRESHOLD,
    lowercaseWordMaxLength: lowercaseWordMaxLength ?? LOWERCASE_WORD_SINGLE_TOKEN_LENGTH,
    hanziCharsPerToken: hanziCharsPerToken ?? HANZI_CHARS_PER_TOKEN,
    kanaCharsPerToken: kanaCharsPerToken ?? KANA_CHARS_PER_TOKEN,
    hangulCharsPerToken: hangulCharsPerToken ?? HANGUL_CHARS_PER_TOKEN,
    languageConfigs: languageConfigs ?? resolveDefaultLanguageConfigs(languageCharsPerToken),
    // Custom configs carry no guarantee that they need a non-ASCII character.
    languageConfigsNeedNonAscii: languageConfigs === undefined,
    segmentCache: new Map(),
  }
}

function resolveDefaultLanguageConfigs(overrides: Partial<Record<LanguageId, number>> | undefined): LanguageConfig[] {
  if (!overrides)
    return DEFAULT_LANGUAGE_CONFIGS

  return DEFAULT_LANGUAGE_CONFIGS.map(config => ({
    id: config.id,
    pattern: config.pattern,
    averageCharsPerToken: overrides[config.id] ?? config.averageCharsPerToken,
  }))
}

/** Sums the token estimates of all segments of a text, without one allocation per segment. */
export function countTextTokens(text: string, options: ResolvedTokenEstimationOptions): number {
  if (!text)
    return 0

  const scanner = new SegmentScanner(text, options)
  let tokenCount = 0
  while (scanner.next())
    tokenCount += scanner.tokenCount

  return tokenCount
}

/**
 * Walks a text as (segment, estimated token count) pairs. The segments
 * concatenate back to the original text; whitespace segments count zero
 * tokens unless they carry structure (indentation or blank lines).
 */
export function* walkSegments(text: string, options: ResolvedTokenEstimationOptions): Generator<SegmentEstimate> {
  if (!text)
    return

  const scanner = new SegmentScanner(text, options)
  while (scanner.next())
    yield { segment: text.slice(scanner.start, scanner.end), tokenCount: scanner.tokenCount }
}

/**
 * Splits a text into maximal runs of whitespace, of punctuation, and of all
 * other characters (words), and prices each run. A scan over character codes
 * replaces a regex split: ASCII words need no substring and no regex test.
 */
class SegmentScanner {
  start = 0
  end = 0
  tokenCount = 0
  private previousIsPunctuation = false
  private readonly text: string
  private readonly options: ResolvedTokenEstimationOptions

  constructor(text: string, options: ResolvedTokenEstimationOptions) {
    this.text = text
    this.options = options
  }

  next(): boolean {
    const { text, options } = this
    const length = text.length
    let index = this.end
    if (index >= length)
      return false

    this.start = index
    const characterClass = getCharacterClass(text.charCodeAt(index))

    if (characterClass === WHITESPACE) {
      let lineBreakIndex = -1
      while (index < length) {
        const code = text.charCodeAt(index)
        if (getCharacterClass(code) !== WHITESPACE)
          break
        if (code === LINE_FEED && lineBreakIndex === -1)
          lineBreakIndex = index
        index++
      }

      if (lineBreakIndex === -1) {
        this.tokenCount = 0
      }
      // The run is all whitespace, so a line break before its last character
      // is followed by more whitespace: indentation and blank lines cost a
      // token in o200k.
      else if (lineBreakIndex < index - 1) {
        this.tokenCount = 1
      }
      // A line break merges into a preceding punctuation token but stands on
      // its own after a word. Single spaces always merge.
      else {
        this.tokenCount = this.previousIsPunctuation ? 0 : 1
      }
      this.previousIsPunctuation = false
    }
    else if (characterClass === PUNCTUATION) {
      while (index < length && getCharacterClass(text.charCodeAt(index)) === PUNCTUATION)
        index++

      this.tokenCount = options.languageConfigsNeedNonAscii
        ? estimatePunctuationRunTokens(index - this.start, options)
        : estimateSegmentTokens(text.slice(this.start, index), true, options)
      this.previousIsPunctuation = true
    }
    else {
      let hasNonAscii = false
      let flags = DIGIT_FLAG | LOWERCASE_FLAG
      while (index < length) {
        const code = text.charCodeAt(index)
        if (code < 128) {
          const entry = ASCII_CHARACTER_CLASSES[code]!
          if ((entry & CLASS_MASK) !== WORD)
            break
          flags &= entry
        }
        else {
          if (isNonAsciiWhitespace(code))
            break
          hasNonAscii = true
        }
        index++
      }
      const isNumeric = (flags & DIGIT_FLAG) !== 0
      const isLowercase = (flags & LOWERCASE_FLAG) !== 0

      this.tokenCount = hasNonAscii || !options.languageConfigsNeedNonAscii
        ? estimateCachedWordTokens(text.slice(this.start, index), options)
        : estimateAsciiWordTokens(index - this.start, isNumeric, isLowercase, options)
      this.previousIsPunctuation = false
    }

    this.end = index
    return true
  }
}

function getCharacterClass(code: number): number {
  if (code < 128)
    return ASCII_CHARACTER_CLASSES[code]! & CLASS_MASK
  return isNonAsciiWhitespace(code) ? WHITESPACE : WORD
}

/** The non-ASCII characters that `\s` matches. */
function isNonAsciiWhitespace(code: number): boolean {
  return code === 0xA0
    || code === 0x1680
    || (code >= 0x2000 && code <= 0x200A)
    || code === 0x2028
    || code === 0x2029
    || code === 0x202F
    || code === 0x205F
    || code === 0x3000
    || code === 0xFEFF
}

function estimateAsciiWordTokens(
  length: number,
  isNumeric: boolean,
  isLowercase: boolean,
  options: ResolvedTokenEstimationOptions,
): number {
  if (isNumeric)
    return Math.ceil(length / options.digitsPerToken)
  if (length <= options.shortTokenThreshold)
    return 1
  // o200k merges common lowercase words of up to eight characters into a
  // single token. The lowercase gate keeps capitalized compounds and scripts
  // without a built-in rule at the default ratio.
  if (isLowercase && length <= options.lowercaseWordMaxLength)
    return 1
  return Math.ceil(length / options.defaultCharsPerToken)
}

function estimatePunctuationRunTokens(length: number, options: ResolvedTokenEstimationOptions): number {
  if (length <= options.shortTokenThreshold)
    return 1
  return Math.ceil(length / options.punctuationCharsPerToken)
}

// Bounds the memory of the segment cache. A full cache starts again empty.
const MAX_CACHED_SEGMENTS = 8192

function estimateCachedWordTokens(segment: string, options: ResolvedTokenEstimationOptions): number {
  const cache = options.segmentCache
  let tokenCount = cache.get(segment)
  if (tokenCount === undefined) {
    tokenCount = estimateSegmentTokens(segment, false, options)
    if (cache.size >= MAX_CACHED_SEGMENTS)
      cache.clear()
    cache.set(segment, tokenCount)
  }
  return tokenCount
}

/** Prices a word or punctuation run that may match a language config. */
function estimateSegmentTokens(
  segment: string,
  isPunctuation: boolean,
  options: ResolvedTokenEstimationOptions,
): number {
  // Checked before the built-in rules so custom configs can override them.
  // Punctuation is ASCII, so it can only match a custom config.
  const hasNonAscii = !isPunctuation && PATTERNS.nonAscii.test(segment)
  if (hasNonAscii || !options.languageConfigsNeedNonAscii) {
    const languageCharsPerToken = getLanguageSpecificCharsPerToken(segment, options.languageConfigs)
    if (languageCharsPerToken !== undefined) {
      return Math.ceil(getCharacterCount(segment) / languageCharsPerToken)
    }
  }

  if (hasNonAscii && PATTERNS.cjk.test(segment)) {
    return estimateCjkTokens(segment, options)
  }

  if (isPunctuation)
    return estimatePunctuationRunTokens(segment.length, options)

  return estimateAsciiWordTokens(
    segment.length,
    PATTERNS.numeric.test(segment),
    PATTERNS.lowercaseWord.test(segment),
    options,
  )
}

function getLanguageSpecificCharsPerToken(segment: string, languageConfigs: LanguageConfig[]): number | undefined {
  for (const config of languageConfigs) {
    // `search` instead of `test`: it ignores `lastIndex`, so stateful flags
    // (`/g`, `/y`) on user-supplied patterns can't skew matching.
    if (segment.search(config.pattern) !== -1) {
      return config.averageCharsPerToken
    }
  }
}

function getCharacterCount(text: string): number {
  return Array.from(text).length
}

function estimateCjkTokens(segment: string, options: ResolvedTokenEstimationOptions): number {
  let kanaCount = 0
  let hangulCount = 0
  let hanziCount = 0

  for (const character of segment) {
    const codePoint = character.codePointAt(0)!

    if (codePoint >= 0x3040 && codePoint <= 0x30FF)
      kanaCount++
    else if (isHangulCodePoint(codePoint))
      hangulCount++
    else
      hanziCount++
  }

  // One rounding for the whole segment: rounding each script on its own would
  // charge a token for every script boundary in mixed CJK text.
  return Math.ceil(
    hanziCount / options.hanziCharsPerToken
    + kanaCount / options.kanaCharsPerToken
    + hangulCount / options.hangulCharsPerToken,
  )
}

function isHangulCodePoint(codePoint: number): boolean {
  return (codePoint >= 0xAC00 && codePoint <= 0xD7AF)
    || (codePoint >= 0x1100 && codePoint <= 0x11FF)
    || (codePoint >= 0x3130 && codePoint <= 0x318F)
    || (codePoint >= 0xA960 && codePoint <= 0xA97F)
    || (codePoint >= 0xD7B0 && codePoint <= 0xD7FF)
}
