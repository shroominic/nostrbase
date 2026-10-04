import { NostrbaseError } from "./errors";

export type ImageFormat = "png" | "jpeg" | "webp";
export interface ImageTransformOptions {
  width?: number;
  height?: number;
  /** Default: cover. With one dimension, keep the aspect ratio. */
  resize?: "cover" | "contain" | "fill" | "inside";
  format?: ImageFormat;
  /** Encoder quality from 1 to 100; PNG is lossless. */
  quality?: number;
  /** Clockwise degrees, applied before resizing. */
  rotate?: 0 | 90 | 180 | 270;
  flip?: boolean;
  flop?: boolean;
  /** Crop after orientation/rotation and flips, before resizing. */
  crop?: { left: number; top: number; width: number; height: number };
  withoutEnlargement?: boolean;
  /** Contain padding and JPEG transparency fill. Default: transparent. */
  background?: string;
}
export interface ImageProcessingOptions extends ImageTransformOptions {
  signal?: AbortSignal;
}
export interface ImageProcessor {
  process(blob: Blob, options: ImageTransformOptions, signal?: AbortSignal): Promise<Blob>;
}
export const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 40_000_000;
const formats = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" } as const;
export function imageMime(format: ImageFormat): string {
  return formats[format];
}
export function imageAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new NostrbaseError("ABORTED", "Image processing was aborted.");
}
function dimension(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= 8192;
}
/** Validate and snapshot options before decoding or sending any bytes. */
export function imageOptions(input: ImageTransformOptions = {}): ImageTransformOptions {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new NostrbaseError("INVALID_QUERY", "Image options must be an object.");
  const allowed = new Set([
    "width",
    "height",
    "resize",
    "format",
    "quality",
    "rotate",
    "flip",
    "flop",
    "crop",
    "withoutEnlargement",
    "background",
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key)))
    throw new NostrbaseError("INVALID_QUERY", "Unknown image transform option.");
  if (
    (input.width !== undefined && !dimension(input.width)) ||
    (input.height !== undefined && !dimension(input.height)) ||
    (input.width !== undefined &&
      input.height !== undefined &&
      input.width * input.height > MAX_IMAGE_PIXELS) ||
    (input.resize !== undefined &&
      !["cover", "contain", "fill", "inside"].includes(input.resize)) ||
    (input.format !== undefined && !Object.hasOwn(formats, input.format)) ||
    (input.quality !== undefined &&
      (!Number.isSafeInteger(input.quality) || input.quality < 1 || input.quality > 100)) ||
    (input.rotate !== undefined && ![0, 90, 180, 270].includes(input.rotate)) ||
    [input.flip, input.flop, input.withoutEnlargement].some(
      (v) => v !== undefined && typeof v !== "boolean",
    ) ||
    (input.background !== undefined &&
      (typeof input.background !== "string" ||
        !/^#[\da-f]{6}(?:[\da-f]{2})?$/i.test(input.background)))
  )
    throw new NostrbaseError(
      "INVALID_QUERY",
      "Invalid image dimensions, format, quality, rotation, or background.",
    );
  if (input.crop !== undefined) {
    const c = input.crop;
    if (
      !c ||
      typeof c !== "object" ||
      Array.isArray(c) ||
      Object.keys(c).some((key) => !["left", "top", "width", "height"].includes(key)) ||
      !dimension(c.width) ||
      !dimension(c.height) ||
      !Number.isSafeInteger(c.left) ||
      c.left < 0 ||
      !Number.isSafeInteger(c.top) ||
      c.top < 0
    )
      throw new NostrbaseError(
        "INVALID_QUERY",
        "Crop must have nonnegative offsets and positive dimensions.",
      );
  }
  return { ...input, ...(input.crop ? { crop: { ...input.crop } } : {}) };
}
export async function imageInput(blob: Blob, signal?: AbortSignal): Promise<ImageFormat> {
  imageAbort(signal);
  if (!(blob instanceof Blob) || blob.size === 0 || blob.size > MAX_IMAGE_BYTES)
    throw new NostrbaseError("INVALID_RECORD", "Image must be a nonempty Blob of at most 32 MiB.");
  const bytes = new Uint8Array(await blob.slice(0, 32).arrayBuffer());
  imageAbort(signal);
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => bytes[i] === n)) {
    if (bytes.length >= 24 && String.fromCharCode(...bytes.slice(12, 16)) === "IHDR") {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      imageDimensions(view.getUint32(16), view.getUint32(20));
    }
    return "png";
  }
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
    const data = new Uint8Array(await blob.arrayBuffer());
    imageAbort(signal);
    let index = 2;
    while (index + 3 < data.length && data[index] === 255) {
      while (data[index] === 255) index++;
      const marker = data[index++];
      if (marker === undefined || marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      const size = ((data[index] ?? 0) << 8) | (data[index + 1] ?? 0);
      if (size < 2 || index + size > data.length) break;
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker) && size >= 7) {
        imageDimensions(
          ((data[index + 5] ?? 0) << 8) | (data[index + 6] ?? 0),
          ((data[index + 3] ?? 0) << 8) | (data[index + 4] ?? 0),
        );
        break;
      }
      index += size;
    }
    return "jpeg";
  }
  if (
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
  ) {
    const chunk = String.fromCharCode(...bytes.slice(12, 16));
    if (chunk === "VP8X" && bytes.length >= 30)
      imageDimensions(
        1 + (bytes[24] ?? 0) + ((bytes[25] ?? 0) << 8) + ((bytes[26] ?? 0) << 16),
        1 + (bytes[27] ?? 0) + ((bytes[28] ?? 0) << 8) + ((bytes[29] ?? 0) << 16),
      );
    if (
      chunk === "VP8 " &&
      bytes.length >= 30 &&
      bytes[23] === 0x9d &&
      bytes[24] === 0x01 &&
      bytes[25] === 0x2a
    )
      imageDimensions(
        ((bytes[26] ?? 0) | ((bytes[27] ?? 0) << 8)) & 0x3fff,
        ((bytes[28] ?? 0) | ((bytes[29] ?? 0) << 8)) & 0x3fff,
      );
    if (chunk === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
      const bits =
        ((bytes[21] ?? 0) |
          ((bytes[22] ?? 0) << 8) |
          ((bytes[23] ?? 0) << 16) |
          ((bytes[24] ?? 0) << 24)) >>>
        0;
      imageDimensions(1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff));
    }
    return "webp";
  }
  throw new NostrbaseError("INVALID_RECORD", "Use a PNG, JPEG, or WebP raster image.");
}
export function imageDimensions(width: number, height: number): void {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height > MAX_IMAGE_PIXELS
  )
    throw new NostrbaseError("INVALID_RECORD", "Image dimensions exceed the 40 megapixel limit.");
}
export interface ImageGeometry {
  source: { left: number; top: number; width: number; height: number };
  width: number;
  height: number;
  draw: { left: number; top: number; width: number; height: number };
}
/** Shared geometry keeps browser and Node adapters consistent. */
export function imageGeometry(
  width: number,
  height: number,
  o: ImageTransformOptions,
): ImageGeometry {
  imageDimensions(width, height);
  const source = o.crop ?? { left: 0, top: 0, width, height };
  if (source.left + source.width > width || source.top + source.height > height)
    throw new NostrbaseError("INVALID_QUERY", "Crop exceeds the oriented image bounds.");
  let w =
    o.width ??
    (o.height === undefined
      ? source.width
      : Math.max(1, Math.round((source.width * o.height) / source.height)));
  let h =
    o.height ??
    (o.width === undefined
      ? source.height
      : Math.max(1, Math.round((source.height * o.width) / source.width)));
  const fit = o.resize ?? "cover";
  let scale = (fit === "cover" ? Math.max : Math.min)(w / source.width, h / source.height);
  if (o.withoutEnlargement) scale = Math.min(1, scale);
  let drawWidth = fit === "fill" ? w : Math.max(1, Math.round(source.width * scale));
  let drawHeight = fit === "fill" ? h : Math.max(1, Math.round(source.height * scale));
  if (o.withoutEnlargement && fit === "fill") {
    drawWidth = Math.min(w, source.width);
    drawHeight = Math.min(h, source.height);
  }
  if (fit === "inside" || (o.withoutEnlargement && fit !== "contain")) {
    w = Math.min(w, drawWidth);
    h = Math.min(h, drawHeight);
  }
  imageDimensions(w, h);
  return {
    source: { ...source },
    width: w,
    height: h,
    draw: {
      left: Math.floor((w - drawWidth) / 2),
      top: Math.floor((h - drawHeight) / 2),
      width: drawWidth,
      height: drawHeight,
    },
  };
}
function canvas(width: number, height: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof document !== "undefined") {
    const result = document.createElement("canvas");
    result.width = width;
    result.height = height;
    return result;
  }
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
  throw new NostrbaseError(
    "INVALID_CONFIG",
    "Canvas image processing is unavailable. In Node, configure SharpImageProcessor from nostrbase/node.",
  );
}
function context(
  surface: HTMLCanvasElement | OffscreenCanvas,
): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D {
  const result = surface.getContext("2d") as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!result) throw new NostrbaseError("INVALID_CONFIG", "A 2D canvas context is unavailable.");
  return result;
}
async function decode(
  blob: Blob,
  signal?: AbortSignal,
): Promise<{ source: CanvasImageSource; width: number; height: number; close(): void }> {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
    if (signal?.aborted) {
      bitmap.close();
      imageAbort(signal);
    }
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      close: () => bitmap.close(),
    };
  }
  if (typeof document === "undefined")
    throw new NostrbaseError("INVALID_CONFIG", "An image decoder is unavailable.");
  const img = document.createElement("img");
  const url = URL.createObjectURL(blob);
  try {
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        cleanup();
        img.src = "";
        reject(new NostrbaseError("ABORTED", "Image processing was aborted."));
      };
      const cleanup = () => signal?.removeEventListener("abort", abort);
      img.onload = () => {
        cleanup();
        resolve();
      };
      img.onerror = () => {
        cleanup();
        reject(new NostrbaseError("INVALID_RECORD", "Image could not be decoded."));
      };
      signal?.addEventListener("abort", abort, { once: true });
      img.src = url;
      if (signal?.aborted) {
        cleanup();
        abort();
      }
    });
    return {
      source: img,
      width: img.naturalWidth,
      height: img.naturalHeight,
      close: () => {
        img.src = "";
        URL.revokeObjectURL(url);
      },
    };
  } catch (error) {
    img.src = "";
    URL.revokeObjectURL(url);
    throw error;
  }
}
async function encode(
  surface: HTMLCanvasElement | OffscreenCanvas,
  format: ImageFormat,
  quality: number,
): Promise<Blob> {
  const type = imageMime(format);
  const blob =
    "convertToBlob" in surface
      ? await surface.convertToBlob({ type, quality: quality / 100 })
      : await new Promise<Blob>((resolve, reject) =>
          surface.toBlob(
            (value) =>
              value
                ? resolve(value)
                : reject(new NostrbaseError("INVALID_RECORD", "Image encoding failed.")),
            type,
            quality / 100,
          ),
        );
  if (blob.type !== type)
    throw new NostrbaseError(
      "INVALID_CONFIG",
      "The image encoder does not support the requested format.",
    );
  return blob;
}
/** Built-in local processor. EXIF orientation is decoded before explicit transforms; metadata is removed. */
export class CanvasImageProcessor implements ImageProcessor {
  async process(
    blob: Blob,
    options: ImageTransformOptions = {},
    signal?: AbortSignal,
  ): Promise<Blob> {
    const o = imageOptions(options);
    const originalFormat = await imageInput(blob, signal);
    let decoded: Awaited<ReturnType<typeof decode>> | undefined;
    const surfaces: (HTMLCanvasElement | OffscreenCanvas)[] = [];
    try {
      decoded = await decode(blob, signal);
      imageAbort(signal);
      imageDimensions(decoded.width, decoded.height);
      const rotated = o.rotate === 90 || o.rotate === 270;
      const width = rotated ? decoded.height : decoded.width;
      const height = rotated ? decoded.width : decoded.height;
      const oriented = canvas(width, height);
      surfaces.push(oriented);
      const ctx = context(oriented);
      ctx.translate(width / 2, height / 2);
      ctx.scale(o.flop ? -1 : 1, o.flip ? -1 : 1);
      ctx.rotate(((o.rotate ?? 0) * Math.PI) / 180);
      ctx.drawImage(decoded.source, -decoded.width / 2, -decoded.height / 2);
      const g = imageGeometry(width, height, o);
      const output = canvas(g.width, g.height);
      surfaces.push(output);
      const out = context(output);
      const format = o.format ?? originalFormat;
      const s = g.source;
      const d = g.draw;
      if (o.background) {
        out.fillStyle = format === "jpeg" ? o.background.slice(0, 7) : o.background;
        if (format === "jpeg") out.fillRect(0, 0, g.width, g.height);
        else {
          // Padding must not flatten alpha in the image itself.
          if (d.top > 0) out.fillRect(0, 0, g.width, d.top);
          if (d.top + d.height < g.height)
            out.fillRect(0, d.top + d.height, g.width, g.height - d.top - d.height);
          if (d.left > 0) out.fillRect(0, Math.max(0, d.top), d.left, Math.min(g.height, d.height));
          if (d.left + d.width < g.width)
            out.fillRect(
              d.left + d.width,
              Math.max(0, d.top),
              g.width - d.left - d.width,
              Math.min(g.height, d.height),
            );
        }
      }
      out.drawImage(oriented, s.left, s.top, s.width, s.height, d.left, d.top, d.width, d.height);
      imageAbort(signal);
      const result = await encode(output, format, o.quality ?? 80);
      imageAbort(signal);
      return result;
    } catch (error) {
      if (error instanceof NostrbaseError) throw error;
      throw new NostrbaseError("INVALID_RECORD", "Image could not be decoded or encoded.");
    } finally {
      decoded?.close();
      for (const surface of surfaces) {
        surface.width = 0;
        surface.height = 0;
      }
    }
  }
}
