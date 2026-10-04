import sharp from "sharp";
import { describe, expect } from "vitest";
import { CanvasImageProcessor, createClient } from "../src";
import { imageGeometry, imageOptions } from "../src/image";
import { SharpImageProcessor } from "../src/node";
import { BlossomServer } from "./support/blossom";
import { deferred, required, test } from "./support/lifecycle";

const pixels = new Uint8Array([
  255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0, 255, 255, 255, 0, 0, 0,
]);
async function image(): Promise<Blob> {
  return new Blob(
    [
      new Uint8Array(
        await sharp(pixels, { raw: { width: 2, height: 3, channels: 3 } })
          .png()
          .toBuffer(),
      ),
    ],
    { type: "image/png" },
  );
}
async function decoded(blob: Blob) {
  return sharp(new Uint8Array(await blob.arrayBuffer()))
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
}

describe("local image processing and verified Blossom bytes", () => {
  test("rotates, flips, crops, and converts actual raster pixels without a service", async ({
    scope,
  }) => {
    const { client, transport } = scope.client({
      storage: { imageProcessor: new SharpImageProcessor() },
    });
    const original = await image();
    const result = await client.storage.processImage(original, {
      rotate: 90,
      crop: { left: 1, top: 0, width: 2, height: 2 },
      format: "png",
    });
    expect(result.error).toBeNull();
    const output = await decoded(required(result.data));
    expect([output.info.width, output.info.height]).toEqual([2, 2]);
    expect([...output.data]).toEqual([0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 0]);
    const flipped = await decoded(
      required((await client.storage.processImage(original, { flip: true, flop: true })).data),
    );
    expect([...flipped.data]).toEqual([
      0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255, 0, 255, 0, 255, 0, 0,
    ]);
    for (const format of ["jpeg", "webp"] as const) {
      const converted = await client.storage.processImage(original, {
        width: 8,
        height: 6,
        resize: "fill",
        format,
        quality: 90,
      });
      expect(converted.error).toBeNull();
      expect(converted.data?.type).toBe(`image/${format}`);
      const meta = await sharp(
        new Uint8Array(await required(converted.data).arrayBuffer()),
      ).metadata();
      expect([meta.width, meta.height, meta.format]).toEqual([8, 6, format]);
      expect(meta.exif).toBeUndefined();
    }
    expect(transport.published).toEqual([]);
  });

  test("keeps aspect ratio, contains with padding, crops cover, and prevents enlargement", async ({
    scope,
  }) => {
    const client = scope.client({ storage: { imageProcessor: new SharpImageProcessor() } }).client;
    const original = await image();
    const contain = await decoded(
      required(
        (
          await client.storage.processImage(original, {
            width: 6,
            height: 6,
            resize: "contain",
            background: "#ff00ff",
          })
        ).data,
      ),
    );
    expect([contain.info.width, contain.info.height]).toEqual([6, 6]);
    expect([...contain.data.subarray(0, 3)]).toEqual([255, 0, 255]);
    for (const [options, size] of [
      [{ width: 4 }, [4, 6]],
      [{ height: 6 }, [4, 6]],
      [{ width: 6, height: 6, resize: "inside" as const }, [4, 6]],
      [{ width: 6, height: 6, resize: "cover" as const }, [6, 6]],
      [{ width: 6, height: 6, withoutEnlargement: true }, [2, 3]],
    ] as const) {
      const out = await decoded(
        required((await client.storage.processImage(original, options)).data),
      );
      expect([out.info.width, out.info.height]).toEqual(size);
    }
    const crop = { left: 0, top: 0, width: 2, height: 2 };
    const o = imageOptions({ crop });
    crop.width = 1;
    expect(imageGeometry(2, 3, o).source.width).toBe(2);
  });

  test("preserves source alpha in PNG padding and uses opaque RGB background for JPEG", async ({
    scope,
  }) => {
    const client = scope.client({ storage: { imageProcessor: new SharpImageProcessor() } }).client;
    const input = await sharp(new Uint8Array([255, 0, 0, 128, 0, 0, 0, 0]), {
      raw: { width: 2, height: 1, channels: 4 },
    })
      .png()
      .toBuffer();
    const out = required(
      (
        await client.storage.processImage(new Blob([new Uint8Array(input)]), {
          width: 2,
          height: 3,
          resize: "contain",
          format: "png",
          background: "#00ff0080",
        })
      ).data,
    );
    const raw = await sharp(new Uint8Array(await out.arrayBuffer()))
      .ensureAlpha()
      .raw()
      .toBuffer();
    // RGB bytes under zero alpha are codec-specific; their visible value is transparent.
    const visible = [...raw];
    visible.splice(12, 3, 0, 0, 0);
    expect(raw[15]).toBe(0);
    expect(visible).toEqual([
      0, 255, 0, 128, 0, 255, 0, 128, 255, 0, 0, 128, 0, 0, 0, 0, 0, 255, 0, 128, 0, 255, 0, 128,
    ]);
    const transparent = await sharp(new Uint8Array([0, 0, 0, 0]), {
      raw: { width: 1, height: 1, channels: 4 },
    })
      .png()
      .toBuffer();
    const jpg = required(
      (
        await client.storage.processImage(new Blob([new Uint8Array(transparent)]), {
          format: "jpeg",
          background: "#00ff0080",
          quality: 100,
        })
      ).data,
    );
    const rgb = (await decoded(jpg)).data;
    expect(rgb[0]).toBeLessThan(3);
    expect(rgb[1]).toBeGreaterThan(252);
    expect(rgb[2]).toBeLessThan(3);
  });

  test("cover crops a wide source to a tall target without materializing an oversized raster", async ({
    scope,
  }) => {
    const client = scope.client({ storage: { imageProcessor: new SharpImageProcessor() } }).client;
    // Full resize-before-crop would allocate 262144×2048 pixels (512 MP).
    // This shape must work as a bounded final raster even with strong aspect changes.
    const input = await sharp({
      create: { width: 2048, height: 16, channels: 3, background: "#00ff00" },
    })
      .png()
      .toBuffer();
    const result = await client.storage.processImage(
      new Blob([new Uint8Array(input)], { type: "image/png" }),
      { width: 16, height: 2048, format: "png" },
    );
    expect(result.error).toBeNull();
    const image = await decoded(required(result.data));
    expect([image.info.width, image.info.height]).toEqual([16, 2048]);
    expect([...image.data.subarray(0, 3)]).toEqual([0, 255, 0]);
  });

  test("normalizes EXIF orientation and strips metadata before explicit rotation", async ({
    scope,
  }) => {
    const client = scope.client({ storage: { imageProcessor: new SharpImageProcessor() } }).client;
    const bytes = await sharp(pixels, { raw: { width: 2, height: 3, channels: 3 } })
      .jpeg({ quality: 100, chromaSubsampling: "4:4:4" })
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const original = new Blob([new Uint8Array(bytes)], { type: "image/jpeg" });
    const out = required(
      (await client.storage.processImage(original, { rotate: 90, format: "png" })).data,
    );
    const meta = await sharp(new Uint8Array(await out.arrayBuffer())).metadata();
    expect([meta.width, meta.height]).toEqual([2, 3]);
    expect(meta.exif).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
    const decodedImage = await decoded(out);
    expect(decodedImage.data[0]).toBeLessThan(10);
  });

  test("rejects malformed, unsupported, oversized, canceled, and out-of-bounds transforms before upload", async ({
    scope,
  }) => {
    const server = await new BlossomServer().start();
    scope.defer(() => server.close());
    const client = scope.client({ storage: { imageProcessor: new SharpImageProcessor() } }).client;
    const bucket = client.storage.from(server.url);
    const original = await image();
    for (const transform of [
      { width: 0 },
      { quality: 101 },
      { crop: { left: 1, top: 0, width: 2, height: 2 } },
      { rotate: 45 },
    ]) {
      const result = await bucket.upload("bad.png", original, { transform: transform as never });
      expect(result.error?.code).toBe("INVALID_QUERY");
      expect(result.data).toBeNull();
    }
    for (const bad of [
      new Blob([]),
      new Blob(["<svg></svg>"], { type: "image/png" }),
      new Blob([new Uint8Array(33 * 1024 * 1024)]),
    ])
      expect((await client.storage.processImage(bad)).error?.code).toBe("INVALID_RECORD");
    const corrupt = new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])]);
    expect((await client.storage.processImage(corrupt)).error?.code).toBe("INVALID_RECORD");
    const controller = new AbortController();
    controller.abort();
    expect(
      (
        await bucket.upload("aborted.png", original, {
          signal: controller.signal,
          transform: { width: 1 },
        })
      ).error?.code,
    ).toBe("ABORTED");
    expect(server.requests).toEqual([]);
    // Browser entry does not silently import a Node codec.
    await expect(new CanvasImageProcessor().process(original)).rejects.toMatchObject({
      code: "INVALID_CONFIG",
    });
  });

  test("hashes and authorizes transformed uploads, verifies originals before transformed download, and preserves original objects", async ({
    scope,
  }) => {
    const server = await new BlossomServer().start();
    scope.defer(() => server.close());
    const client = scope.client({ storage: { imageProcessor: new SharpImageProcessor() } }).client;
    const bucket = client.storage.from(server.url);
    const original = await image();
    const originalUpload = required((await bucket.upload("original.png", original)).data);
    const resized = required(
      (await bucket.upload("resized.webp", original, { transform: { width: 4, format: "webp" } }))
        .data,
    );
    expect(resized.sha256).not.toBe(originalUpload.sha256);
    expect(resized.type).toBe("image/webp");
    const read = await bucket.download(originalUpload.sha256, {
      transform: { width: 6, height: 6, resize: "fill", format: "png" },
    });
    expect(read.error).toBeNull();
    const result = await decoded(required(read.data));
    expect([result.info.width, result.info.height]).toEqual([6, 6]);
    expect((await bucket.download(originalUpload.sha256)).data?.size).toBe(original.size);
    server.corruptDownload = true;
    expect(
      (await bucket.download(originalUpload.sha256, { transform: { width: 1 } })).error?.code,
    ).toBe("INVALID_RECORD");
    expect(server.objects.size).toBe(2);
    expect(
      (await bucket.download(originalUpload.sha256, { transform: { width: -1 } })).error?.code,
    ).toBe("INVALID_QUERY");
  });

  test("suppresses adapter completion after caller cancellation or client close", async ({
    scope,
  }) => {
    const started = [deferred(), deferred()];
    const completions = [deferred<Blob>(), deferred<Blob>()];
    let call = 0;
    const processor = {
      process: () => {
        const index = call++;
        required(started[index]).resolve();
        return required(completions[index]).promise;
      },
    };
    const client = scope.client({ storage: { imageProcessor: processor } }).client;
    const original = await image();
    scope.defer(() => {
      for (const completion of completions) completion.resolve(original);
    });
    const controller = new AbortController();
    const pending = client.storage.processImage(original, { signal: controller.signal });
    await required(started[0]).promise;
    controller.abort();
    required(completions[0]).resolve(original);
    expect((await pending).error?.code).toBe("ABORTED");
    const second = client.storage.processImage(original);
    await required(started[1]).promise;
    await client.closeAsync();
    required(completions[1]).resolve(original);
    expect((await second).error?.code).toBe("ABORTED");
    const closed = createClient({ namespace: "images-closed", relays: ["ws://127.0.0.1:1"] });
    await closed.closeAsync();
    expect((await closed.storage.processImage(original)).error?.code).toBe("CLIENT_CLOSED");
  });
});
