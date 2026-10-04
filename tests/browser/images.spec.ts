import sharp from "sharp";
import { BlossomServer } from "../support/blossom";
import { expect, test } from "./support/fixtures";

const pixels = new Uint8Array([
  255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0, 255, 255, 255, 0, 0, 0,
]);

test("local Canvas transforms actual pixels and uploads their verified hash across HTTP origins", async ({
  page,
  harness,
}) => {
  const server = await new BlossomServer().start();
  try {
    const bytes = await sharp(pixels, { raw: { width: 2, height: 3, channels: 3 } })
      .png()
      .toBuffer();
    await page.goto(harness.url);
    await page.waitForFunction(() => window.harnessReady);
    const result = await page.evaluate(
      async ({ encoded, serverURL, relay }) => {
        const db = window.nostrbase.createClient({
          namespace: "image-browser",
          relays: [relay],
          signer: new window.nostrbase.PrivateKeySigner(new Uint8Array(32).fill(3)),
        });
        const original = new Blob([Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0))], {
          type: "image/png",
        });
        async function inspect(blob: Blob) {
          const source = await createImageBitmap(blob);
          try {
            const canvas = document.createElement("canvas");
            canvas.width = source.width;
            canvas.height = source.height;
            const ctx = canvas.getContext("2d");
            if (!ctx) throw new Error("No canvas context");
            ctx.drawImage(source, 0, 0);
            return {
              width: source.width,
              height: source.height,
              pixels: [...ctx.getImageData(0, 0, source.width, source.height).data],
            };
          } finally {
            source.close();
          }
        }
        try {
          const transformed = await db.storage.processImage(original, {
            rotate: 90,
            crop: { left: 1, top: 0, width: 2, height: 2 },
            format: "png",
          });
          if (transformed.error || !transformed.data)
            throw transformed.error ?? new Error("No image");
          const actual = await inspect(transformed.data);
          const converted = await db.storage.processImage(original, {
            width: 8,
            height: 6,
            resize: "fill",
            format: "jpeg",
            quality: 90,
          });
          if (converted.error || !converted.data) throw converted.error ?? new Error("No JPEG");
          const jpeg = await inspect(converted.data);
          const bucket = db.storage.from(serverURL);
          const uploaded = await bucket.upload("image.png", original, {
            transform: { width: 4, height: 6, format: "png" },
          });
          if (uploaded.error || !uploaded.data) throw uploaded.error ?? new Error("No upload");
          const downloaded = await bucket.download(uploaded.data.sha256, {
            transform: { width: 2, height: 2, resize: "cover", format: "png" },
          });
          if (downloaded.error || !downloaded.data)
            throw downloaded.error ?? new Error("No download");
          const read = await inspect(downloaded.data);
          const untouched = await bucket.download(uploaded.data.sha256);
          if (untouched.error || !untouched.data)
            throw untouched.error ?? new Error("No original bytes");
          const hash = Array.from(
            new Uint8Array(
              await crypto.subtle.digest("SHA-256", await untouched.data.arrayBuffer()),
            ),
            (byte) => byte.toString(16).padStart(2, "0"),
          ).join("");
          return {
            actual,
            jpeg: { width: jpeg.width, height: jpeg.height, type: converted.data.type },
            read: { width: read.width, height: read.height },
            hash,
            uploadedHash: uploaded.data.sha256,
          };
        } finally {
          await db.closeAsync();
        }
      },
      { encoded: bytes.toString("base64"), serverURL: server.url, relay: harness.relay.url },
    );
    expect(result.actual).toEqual({
      width: 2,
      height: 2,
      pixels: [0, 0, 255, 255, 255, 0, 0, 255, 255, 255, 0, 255, 0, 255, 0, 255],
    });
    expect(result.jpeg).toEqual({ width: 8, height: 6, type: "image/jpeg" });
    expect(result.read).toEqual({ width: 2, height: 2 });
    expect(result.hash).toBe(result.uploadedHash);
    expect(server.requests.filter((request) => request.method === "PUT")).toHaveLength(1);
    expect(harness.relay.frames.filter((frame) => frame[0] === "EVENT")).toHaveLength(0);
  } finally {
    await server.close();
  }
});

test("Canvas orientation, padding, invalid images and canceled work preserve storage boundaries", async ({
  page,
  harness,
}) => {
  const bytes = await sharp(pixels, { raw: { width: 2, height: 3, channels: 3 } })
    .jpeg({ quality: 100, chromaSubsampling: "4:4:4" })
    .withMetadata({ orientation: 6 })
    .toBuffer();
  await page.goto(harness.url);
  await page.waitForFunction(() => window.harnessReady);
  const result = await page.evaluate(
    async ({ encoded, relay }) => {
      const db = window.nostrbase.createClient({ namespace: "image-validation", relays: [relay] });
      const original = new Blob([Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0))], {
        type: "image/jpeg",
      });
      try {
        const rotated = await db.storage.processImage(original, { rotate: 90, format: "png" });
        if (rotated.error || !rotated.data) throw rotated.error ?? new Error("No rotated image");
        const source = await createImageBitmap(rotated.data);
        const dimensions = [source.width, source.height];
        source.close();
        const padded = await db.storage.processImage(original, {
          width: 6,
          height: 6,
          resize: "contain",
          format: "png",
          background: "#ff00ff",
        });
        if (padded.error || !padded.data) throw padded.error ?? new Error("No padded image");
        const img = await createImageBitmap(padded.data);
        const canvas = document.createElement("canvas");
        canvas.width = 6;
        canvas.height = 6;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("No context");
        ctx.drawImage(img, 0, 0);
        img.close();
        const corner = [...ctx.getImageData(0, 0, 1, 1).data];
        const invalid = (
          await db.storage.processImage(original, {
            crop: { left: 50, top: 0, width: 1, height: 1 },
          })
        ).error?.code;
        const unsupported = (
          await db.storage.processImage(new Blob(["<svg></svg>"], { type: "image/png" }))
        ).error?.code;
        const controller = new AbortController();
        controller.abort();
        const canceled = (await db.storage.processImage(original, { signal: controller.signal }))
          .error?.code;
        return { dimensions, corner, invalid, unsupported, canceled };
      } finally {
        await db.closeAsync();
      }
    },
    { encoded: bytes.toString("base64"), relay: harness.relay.url },
  );
  expect(result).toEqual({
    dimensions: [2, 3],
    corner: [255, 0, 255, 255],
    invalid: "INVALID_QUERY",
    unsupported: "INVALID_RECORD",
    canceled: "ABORTED",
  });
  expect(harness.relay.frames.filter((frame) => frame[0] === "EVENT")).toHaveLength(0);
});

test("Canvas preserves source alpha while padding and flattens JPEG on opaque RGB", async ({
  page,
  harness,
}) => {
  const bytes = await sharp(new Uint8Array([255, 0, 0, 128, 0, 0, 0, 0]), {
    raw: { width: 2, height: 1, channels: 4 },
  })
    .png()
    .toBuffer();
  await page.goto(harness.url);
  await page.waitForFunction(() => window.harnessReady);
  const result = await page.evaluate(
    async ({ encoded, relay }) => {
      const db = window.nostrbase.createClient({ namespace: "image-alpha", relays: [relay] });
      const blob = new Blob([Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0))]);
      async function pixels(blob: Blob) {
        const img = await createImageBitmap(blob);
        try {
          const canvas = document.createElement("canvas");
          canvas.width = img.width;
          canvas.height = img.height;
          const ctx = canvas.getContext("2d");
          if (!ctx) throw new Error("No context");
          ctx.drawImage(img, 0, 0);
          return [...ctx.getImageData(0, 0, img.width, img.height).data];
        } finally {
          img.close();
        }
      }
      try {
        const png = await db.storage.processImage(blob, {
          width: 2,
          height: 3,
          resize: "contain",
          format: "png",
          background: "#00ff0080",
        });
        if (!png.data || png.error) throw png.error ?? new Error("No PNG");
        const jpg = await db.storage.processImage(blob, {
          format: "jpeg",
          quality: 100,
          background: "#00ff0080",
          crop: { left: 1, top: 0, width: 1, height: 1 },
        });
        if (!jpg.data || jpg.error) throw jpg.error ?? new Error("No JPEG");
        return { png: await pixels(png.data), jpg: await pixels(jpg.data) };
      } finally {
        await db.closeAsync();
      }
    },
    { encoded: bytes.toString("base64"), relay: harness.relay.url },
  );
  expect(result.png).toEqual([
    0, 255, 0, 128, 0, 255, 0, 128, 255, 0, 0, 128, 0, 0, 0, 0, 0, 255, 0, 128, 0, 255, 0, 128,
  ]);
  expect(result.jpg[1]).toBeGreaterThan(252);
  expect(result.jpg[0]).toBeLessThan(3);
  expect(result.jpg[2]).toBeLessThan(3);
  expect(result.jpg[3]).toBe(255);
});
