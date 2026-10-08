/** The geometry fields of a profile that turn an image size into patches. */
export interface ImageGeometry {
  imagePatchSize: number;
  imageMaxEdge: number;
  imageMaxShortEdge: number;
  imageMaxPatches: number;
}

export interface ImageSize {
  width: number;
  height: number;
}

// An image whose size cannot be read, such as a URL, is priced at this size.
const UNKNOWN_IMAGE_SIZE: ImageSize = { width: 1024, height: 1024 };

/**
 * The patches of an image after the provider resizes it: the image is scaled
 * down to fit `imageMaxEdge` and `imageMaxShortEdge`, then its long edge steps
 * down one pixel at a time until it has at most `imageMaxPatches` patches.
 * A limit of 0 is no limit.
 */
export function countImagePatches(
  size: ImageSize | undefined,
  geometry: ImageGeometry,
): number {
  const { width, height } = size ?? UNKNOWN_IMAGE_SIZE;
  const patch = geometry.imagePatchSize;
  if (!(patch > 0)) return 0;
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  const scale = Math.min(
    1,
    geometry.imageMaxEdge > 0 ? geometry.imageMaxEdge / long : 1,
    geometry.imageMaxShortEdge > 0 ? geometry.imageMaxShortEdge / short : 1,
  );
  let a = scale < 1 ? Math.max(1, Math.round(long * scale)) : long;
  let b = scale < 1 ? Math.max(1, Math.round(short * scale)) : short;
  const patches = (): number => Math.ceil(a / patch) * Math.ceil(b / patch);
  if (geometry.imageMaxPatches > 0 && patches() > geometry.imageMaxPatches) {
    // Jump close to the limit, then step down one pixel at a time.
    a = Math.min(
      a,
      Math.ceil(patch * Math.sqrt((geometry.imageMaxPatches * long) / short)) +
        patch,
    );
    b = Math.max(1, Math.round((short * a) / long));
    while (a > 1 && patches() > geometry.imageMaxPatches) {
      a--;
      b = Math.max(1, Math.round((short * a) / long));
    }
  }
  return patches();
}

/**
 * Reads the width and height from the header of a PNG, GIF, WebP or JPEG
 * image given as bytes, a base64 string, a data URL or AI SDK tagged data.
 * Returns `undefined` for URLs, references and unknown or damaged data.
 */
export function readImageSize(data: unknown): ImageSize | undefined {
  if (typeof data === "string") return readBase64ImageSize(data);
  if (data instanceof Uint8Array) return readHeaderSize(data);
  if (data instanceof ArrayBuffer) return readHeaderSize(new Uint8Array(data));
  // AI SDK 7 tags file data: `{ type: 'data', data }`, a URL, or a reference.
  const tagged = data as { type?: unknown; data?: unknown } | null;
  if (typeof tagged === "object" && tagged?.type === "data")
    return readImageSize(tagged.data);
}

function readBase64ImageSize(text: string): ImageSize | undefined {
  let start = 0;
  if (text.startsWith("data:")) {
    const comma = text.indexOf(",");
    if (comma === -1 || !text.slice(0, comma).endsWith(";base64")) return;
    start = comma + 1;
  } else if (/^[a-z][a-z\d+.-]*:\/\//i.test(text)) return;
  // A JPEG size can follow metadata, so decode more of the data until it is found.
  for (let length = 64; ; length *= 4) {
    const end = Math.min(text.length, start + length);
    let bytes: Uint8Array;
    try {
      bytes = Uint8Array.from(
        atob(text.slice(start, end - ((end - start) % 4))),
        (character) => character.charCodeAt(0),
      );
    } catch {
      return;
    }
    const size = readHeaderSize(bytes);
    if (size || bytes[0] !== 0xff || end === text.length) return size;
  }
}

function readHeaderSize(bytes: Uint8Array): ImageSize | undefined {
  const at = (index: number): number => bytes[index] ?? 0;
  const u16be = (index: number): number => (at(index) << 8) | at(index + 1);
  const u16le = (index: number): number => at(index) | (at(index + 1) << 8);
  const u24le = (index: number): number => u16le(index) | (at(index + 2) << 16);
  const u32be = (index: number): number =>
    at(index) * 2 ** 24 + (at(index + 1) << 16) + u16be(index + 2);
  const ascii = (index: number, length: number): string =>
    String.fromCharCode(...bytes.subarray(index, index + length));
  // PNG: the signature, then the IHDR chunk with the size at 16 and 20.
  if (bytes.length >= 24 && ascii(1, 3) === "PNG" && ascii(12, 4) === "IHDR")
    return valid(u32be(16), u32be(20));
  // GIF: the logical screen size at 6 and 8.
  if (bytes.length >= 10 && ascii(0, 4) === "GIF8")
    return valid(u16le(6), u16le(8));
  // WebP: the first chunk at 12 holds the size in its own format.
  if (bytes.length >= 30 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    switch (ascii(12, 4)) {
      case "VP8 ":
        return valid(u16le(26) & 0x3fff, u16le(28) & 0x3fff);
      case "VP8L":
        return valid(
          1 + (at(21) | ((at(22) & 0x3f) << 8)),
          1 + ((at(22) >> 6) | (at(23) << 2) | ((at(24) & 0x0f) << 10)),
        );
      case "VP8X":
        return valid(1 + u24le(24), 1 + u24le(27));
    }
    return;
  }
  // JPEG: segments follow the start marker; a start-of-frame segment holds
  // the height at 5 and the width at 7.
  if (at(0) === 0xff && at(1) === 0xd8) {
    let index = 2;
    while (index + 9 < bytes.length) {
      if (at(index) !== 0xff) return;
      const marker = at(index + 1);
      if (marker === 0xff) index++;
      else if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7))
        index += 2;
      else if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      )
        return valid(u16be(index + 7), u16be(index + 5));
      else index += 2 + u16be(index + 2);
    }
  }
}

function valid(width: number, height: number): ImageSize | undefined {
  return width > 0 && height > 0 ? { width, height } : undefined;
}
