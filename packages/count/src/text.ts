import type {
  ResolvedTokenEstimationOptions,
  SegmentEstimate,
} from "./segments.ts";
import { walkSegments } from "./segments.ts";

/** Extracts a portion of text based on token positions, similar to `Array.prototype.slice()`. */
export function sliceText(
  text: string,
  start: number,
  end: number | undefined,
  options: ResolvedTokenEstimationOptions,
): string {
  if (!text) return "";

  // Negative indices resolve against the total count, which is only known
  // after a full walk – buffer it instead of walking twice.
  let segmentEstimates: Iterable<SegmentEstimate> = walkSegments(text, options);
  let totalTokens = 0;
  if (start < 0 || (end !== undefined && end < 0)) {
    const bufferedEstimates = Array.from(segmentEstimates);
    for (const { tokenCount } of bufferedEstimates) {
      totalTokens += tokenCount;
    }
    segmentEstimates = bufferedEstimates;
  }

  const normalizedStart =
    start < 0 ? Math.max(0, totalTokens + start) : Math.max(0, start);
  const normalizedEnd =
    end === undefined
      ? Infinity
      : end < 0
        ? Math.max(0, totalTokens + end)
        : end;

  if (normalizedStart >= normalizedEnd) return "";

  const parts: string[] = [];
  let currentTokenPos = 0;

  for (const { segment, tokenCount } of segmentEstimates) {
    if (currentTokenPos >= normalizedEnd) break;

    const extracted = extractSegmentPart(
      segment,
      currentTokenPos,
      tokenCount,
      normalizedStart,
      normalizedEnd,
    );
    if (extracted) parts.push(extracted);
    currentTokenPos += tokenCount;
  }

  return parts.join("");
}

/** Splits a text into chunks of about `tokensPerChunk` tokens, repeating `overlap` tokens. */
export function splitText(
  text: string,
  tokensPerChunk: number,
  overlap: number,
  options: ResolvedTokenEstimationOptions,
): string[] {
  if (!text || tokensPerChunk <= 0) return [];

  // An overlap of at least the chunk size would prevent chunks from ever
  // draining, duplicating content without bound.
  const chunkOverlap = Math.max(0, Math.min(overlap, tokensPerChunk - 1));

  const chunks: string[] = [];
  let currentChunk: SegmentEstimate[] = [];
  let currentTokenCount = 0;
  // Overlap segments alone don't justify a trailing chunk – it would only
  // duplicate the end of the previous chunk.
  let hasUnchunkedSegments = false;

  for (const segmentEstimate of walkSegments(text, options)) {
    currentChunk.push(segmentEstimate);
    currentTokenCount += segmentEstimate.tokenCount;
    hasUnchunkedSegments = true;

    if (currentTokenCount >= tokensPerChunk) {
      chunks.push(joinSegments(currentChunk));
      hasUnchunkedSegments = false;

      if (chunkOverlap > 0) {
        const overlapSegments: SegmentEstimate[] = [];
        let overlapTokenCount = 0;

        for (
          let i = currentChunk.length - 1;
          i >= 0 && overlapTokenCount < chunkOverlap;
          i--
        ) {
          const overlapCandidate = currentChunk[i]!;
          overlapSegments.unshift(overlapCandidate);
          overlapTokenCount += overlapCandidate.tokenCount;
        }

        currentChunk = overlapSegments;
        currentTokenCount = overlapTokenCount;
      } else {
        currentChunk = [];
        currentTokenCount = 0;
      }
    }
  }

  if (currentChunk.length > 0 && hasUnchunkedSegments)
    chunks.push(joinSegments(currentChunk));

  return chunks;
}

function joinSegments(segmentEstimates: SegmentEstimate[]): string {
  let joined = "";
  for (const { segment } of segmentEstimates) {
    joined += segment;
  }
  return joined;
}

function extractSegmentPart(
  segment: string,
  segmentTokenStart: number,
  segmentTokenCount: number,
  targetStart: number,
  targetEnd: number,
): string {
  if (segmentTokenCount === 0) {
    return segmentTokenStart >= targetStart && segmentTokenStart < targetEnd
      ? segment
      : "";
  }

  const segmentTokenEnd = segmentTokenStart + segmentTokenCount;
  if (segmentTokenStart >= targetEnd || segmentTokenEnd <= targetStart)
    return "";

  const overlapStart = Math.max(0, targetStart - segmentTokenStart);
  const overlapEnd = Math.min(segmentTokenCount, targetEnd - segmentTokenStart);

  if (overlapStart === 0 && overlapEnd === segmentTokenCount) return segment;

  const charStart = Math.floor(
    (overlapStart / segmentTokenCount) * segment.length,
  );
  const charEnd = Math.ceil((overlapEnd / segmentTokenCount) * segment.length);
  return segment.slice(charStart, charEnd);
}
