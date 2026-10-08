import type {
  LanguageConfig,
  ModelProfileInput,
  TextProfile,
  UsageEstimator,
} from "../../src/index.ts";
import { createUsageEstimator, resolveProfile } from "../../src/index.ts";

/** A profile, text ratios that override its text rules, and estimator options. */
export interface TextOptions extends TextProfile {
  profile?: ModelProfileInput;
  languageConfigs?: LanguageConfig[];
  cache?: boolean;
  overlap?: number;
}

/** An estimator for a profile with some of its text ratios replaced. */
export function textEstimator({
  profile,
  languageConfigs,
  cache,
  overlap: _overlap,
  ...ratios
}: TextOptions = {}): UsageEstimator {
  const options = {
    ...(languageConfigs ? { languageConfigs } : {}),
    ...(cache === false ? { cache } : {}),
  };
  // An undefined option keeps the profile's value.
  const defined = <T extends object>(value: T | undefined): Partial<T> =>
    Object.fromEntries(
      Object.entries(value ?? {}).filter(([, entry]) => entry !== undefined),
    ) as Partial<T>;
  if (!Object.keys(defined(ratios)).length)
    return createUsageEstimator(profile, options);
  const base = resolveProfile(profile);
  return createUsageEstimator(
    {
      ...base,
      text: {
        ...base.text,
        ...defined(ratios),
        languageCharsPerToken: {
          ...base.text.languageCharsPerToken,
          ...defined(ratios.languageCharsPerToken),
        },
        unaccentedWordScale: {
          ...base.text.unaccentedWordScale,
          ...defined(ratios.unaccentedWordScale),
        },
      },
    },
    options,
  );
}

export const countText = (text?: string, options?: TextOptions): number =>
  textEstimator(options).count({ text: text ?? "" });

export const sliceText = (
  text: string,
  start?: number,
  end?: number,
  options?: TextOptions,
): string => textEstimator(options).sliceByTokens(text, start, end);

export const splitText = (
  text: string,
  tokensPerChunk: number,
  options?: TextOptions,
): string[] =>
  textEstimator(options).splitByTokens(text, tokensPerChunk, {
    overlap: options?.overlap,
  });

export const fitsText = (
  text: string,
  limit: number,
  options?: TextOptions,
): boolean => textEstimator(options).isWithinTokenLimit({ text }, limit);
