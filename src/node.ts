import sharp from "sharp";
import { NostrbaseError } from "./errors";
import type { ImageProcessor, ImageTransformOptions } from "./image";
import {
  imageAbort,
  imageDimensions,
  imageGeometry,
  imageInput,
  imageMime,
  imageOptions,
  MAX_IMAGE_PIXELS,
} from "./image";

/** Node image adapter. Import from nostrbase/node; install the optional sharp peer. */
export class SharpImageProcessor implements ImageProcessor {
  async process(
    blob: Blob,
    options: ImageTransformOptions = {},
    signal?: AbortSignal,
  ): Promise<Blob> {
    const o = imageOptions(options);
    const original = await imageInput(blob, signal);
    let operation: ReturnType<typeof sharp> | undefined;
    const abort = () =>
      operation?.destroy(new NostrbaseError("ABORTED", "Image processing was aborted."));
    try {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      imageAbort(signal);
      // Materialize orientation and explicit transforms first so crop coordinates match Canvas.
      operation = sharp(bytes, {
        limitInputPixels: MAX_IMAGE_PIXELS,
        animated: false,
      }).autoOrient();
      signal?.addEventListener("abort", abort, { once: true });
      if (o.rotate) operation = operation.rotate(o.rotate);
      const oriented = await operation.raw().toBuffer({ resolveWithObject: true });
      imageAbort(signal);
      imageDimensions(oriented.info.width, oriented.info.height);
      operation = sharp(oriented.data, {
        raw: {
          width: oriented.info.width,
          height: oriented.info.height,
          channels: oriented.info.channels,
        },
      });
      if (o.flip) operation = operation.flip();
      if (o.flop) operation = operation.flop();
      const flipped = await operation.raw().toBuffer({ resolveWithObject: true });
      imageAbort(signal);
      const g = imageGeometry(flipped.info.width, flipped.info.height, o);
      operation = sharp(flipped.data, {
        raw: {
          width: flipped.info.width,
          height: flipped.info.height,
          channels: flipped.info.channels,
        },
      }).extract(g.source);
      if ((o.resize ?? "cover") === "cover") {
        // Keep center cropping in the streaming pipeline. Do not materialize an
        // oversized cover intermediate for sources with a different aspect ratio.
        operation = operation.resize(g.width, g.height, { fit: "cover", position: "centre" });
      } else {
        imageDimensions(g.draw.width, g.draw.height);
        operation = operation.resize(g.draw.width, g.draw.height, { fit: "fill" });
        if (g.width > g.draw.width || g.height > g.draw.height) {
          operation = operation.ensureAlpha().extend({
            left: g.draw.left,
            top: g.draw.top,
            right: g.width - g.draw.width - g.draw.left,
            bottom: g.height - g.draw.height - g.draw.top,
            background: o.background ?? "#00000000",
          });
        }
      }
      const format = o.format ?? original;
      if (format === "jpeg")
        operation = operation.flatten({ background: o.background ?? "#000000" });
      operation = operation.toFormat(format, { quality: o.quality ?? 80 });
      const output = new Uint8Array(await operation.toBuffer());
      imageAbort(signal);
      return new Blob([output], { type: imageMime(format) });
    } catch (error) {
      imageAbort(signal);
      if (error instanceof NostrbaseError) throw error;
      throw new NostrbaseError("INVALID_RECORD", "Image could not be decoded or encoded.");
    } finally {
      signal?.removeEventListener("abort", abort);
      operation?.destroy();
    }
  }
}
