import type { ModelProfileInput } from "./profiles.ts";

/** Names of the built-in language configs, used to override their ratios. */
export type LanguageId =
  | "german"
  | "romance"
  | "slavicLatin"
  | "cyrillic"
  | "greek"
  | "emoji";

/** The language configs that identify a Latin-script language by its accented words. */
export type AccentLanguageId = "german" | "romance" | "slavicLatin";

/** The JSON-safe ratios of the text rules. Every field is optional and falls back to the built-in o200k calibration. */
export interface TextProfile {
  /** Default average characters per token when no language-specific rule applies (default: 7). */
  defaultCharsPerToken?: number;
  /** Characters per token in a run of punctuation (default: 6). */
  punctuationCharsPerToken?: number;
  /** Digits per token in a run of digits (default: 3). */
  digitsPerToken?: number;
  /** Segments of this length or shorter count as one token (default: 3). */
  shortTokenThreshold?: number;
  /** Lowercase ASCII words of this length or shorter count as one token (default: 8). */
  lowercaseWordMaxLength?: number;
  /**
   * Tokens for a single underscore between two words, as in `snake_case`
   * (default: 0, because o200k joins it to the next word).
   */
  innerUnderscoreTokens?: number;
  /** Characters per token for Chinese characters (default: 1.15). */
  hanziCharsPerToken?: number;
  /** Characters per token for Japanese kana (default: 1.4). */
  kanaCharsPerToken?: number;
  /** Characters per token for Korean hangul (default: 1.65). */
  hangulCharsPerToken?: number;
  /** Ratios that replace the ratios of the built-in language configs. Ignored when `languageConfigs` is set. */
  languageCharsPerToken?: Partial<Record<LanguageId, number>>;
  /**
   * Scales the unaccented ASCII words of a text in which the accent rule of
   * this language matches at least 5% of the words (default: 1). Below 5%,
   * the scale applies in proportion. Ignored when `languageConfigs` is set.
   */
  unaccentedWordScale?: Partial<Record<AccentLanguageId, number>>;
}

export interface TokenEstimationOptions extends TextProfile {
  /** Predefined model ID or custom profile; omitted profiles use the defaults. */
  profile?: ModelProfileInput;
  /** Custom language configurations to override defaults. */
  languageConfigs?: LanguageConfig[];
  /**
   * Reuse estimates of repeated slow-path words, bounded to 8,192 entries.
   * Default `true`; set `false` to keep no state between calls.
   */
  cache?: boolean;
}

export interface LanguageConfig {
  /** Regular expression to detect the language. */
  pattern: RegExp;
  averageCharsPerToken: number;
}

export interface SplitByTokensOptions extends TokenEstimationOptions {
  /** Number of tokens to overlap between consecutive chunks (default: 0, clamped below the target chunk size). */
  overlap?: number;
}
