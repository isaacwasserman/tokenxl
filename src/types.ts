/** Names of the built-in language configs, used to override their ratios. */
export type LanguageId = 'german' | 'romance' | 'slavicLatin' | 'cyrillic' | 'greek' | 'emoji'

/** The JSON-safe ratios of the text rules. Every field is optional and falls back to the built-in o200k calibration. */
export interface TextProfile {
  /** Default average characters per token when no language-specific rule applies (default: 7). */
  defaultCharsPerToken?: number
  /** Characters per token in a run of punctuation (default: 6). */
  punctuationCharsPerToken?: number
  /** Digits per token in a run of digits (default: 3). */
  digitsPerToken?: number
  /** Segments of this length or shorter count as one token (default: 3). */
  shortTokenThreshold?: number
  /** Lowercase ASCII words of this length or shorter count as one token (default: 8). */
  lowercaseWordMaxLength?: number
  /** Characters per token for Chinese characters (default: 1.15). */
  hanziCharsPerToken?: number
  /** Characters per token for Japanese kana (default: 1.4). */
  kanaCharsPerToken?: number
  /** Characters per token for Korean hangul (default: 1.65). */
  hangulCharsPerToken?: number
  /** Ratios that replace the ratios of the built-in language configs. Ignored when `languageConfigs` is set. */
  languageCharsPerToken?: Partial<Record<LanguageId, number>>
}

export interface TokenEstimationOptions extends TextProfile {
  /** Custom language configurations to override defaults. */
  languageConfigs?: LanguageConfig[]
}

export interface LanguageConfig {
  /** Regular expression to detect the language. */
  pattern: RegExp
  averageCharsPerToken: number
}

export interface SplitByTokensOptions extends TokenEstimationOptions {
  /** Number of tokens to overlap between consecutive chunks (default: 0, clamped below the target chunk size). */
  overlap?: number
}
