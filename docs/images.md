# Local image processing

Process PNG, JPEG, and WebP files in the client. No image service or relay operation is needed. The default processor uses browser Canvas. In Node, install the optional `sharp` peer and use the separate adapter.

## Resize before upload

```ts
const bucket = db.storage.from("https://your-blossom.example");
const uploaded = await bucket.upload("avatar.webp", file, {
  transform: {
    width: 256,
    height: 256,
    resize: "cover",
    format: "webp",
    quality: 85,
  },
});
if (uploaded.error) throw uploaded.error;
```

The SDK transforms the file before it calculates its SHA-256 hash or signs the upload token. The returned descriptor identifies the transformed bytes. Your original `Blob` stays unchanged. Blossom stores those bytes as an ordinary object; it does not need a transformation endpoint.

## Download and transform

```ts
const downloaded = await bucket.download(hash, {
  transform: { width: 800, resize: "inside", format: "jpeg", quality: 85 },
  signal,
});
if (downloaded.error) throw downloaded.error;
```

The SDK downloads the original object and checks its hash first. It then transforms the verified bytes locally. The result is a new `Blob`; it does not have the original object's hash and does not replace the server object. Unlike a Supabase transformation URL, this operation downloads the original file. Local resizing cannot reduce that initial network transfer.

## Process without storage

```ts
const processed = await db.storage.processImage(file, {
  rotate: 90,
  crop: { left: 20, top: 10, width: 400, height: 400 },
  width: 200,
  height: 200,
  format: "png",
  signal,
});
if (processed.error) throw processed.error;
```

EXIF orientation is applied first, followed by clockwise rotation, vertical `flip`, horizontal `flop`, crop, and resize. Crop coordinates refer to the oriented and rotated image. Encoding removes source metadata, including EXIF location data. Browser and Node encoders can produce different bytes for the same image.

| Option | Meaning |
| --- | --- |
| `width`, `height` | Positive integer dimensions, each at most 8192. One dimension preserves the aspect ratio. |
| `resize` | `cover` fills and center-crops; `contain` fits with padding; `fill` stretches; `inside` fits without padding. Default: `cover`. |
| `format` | `png`, `jpeg`, or `webp`. Default: the input format. |
| `quality` | Integer 1–100. Default: 80. PNG is lossless. |
| `rotate` | Clockwise 0, 90, 180, or 270 degrees. |
| `flip`, `flop` | Vertical and horizontal mirror operations. |
| `crop` | Nonnegative offsets and positive dimensions within the transformed source. |
| `withoutEnlargement` | Prevent scaling the source above its original size; `contain` can still add padding. |
| `background` | Padding/transparency color: `#RRGGBB` or `#RRGGBBAA`. Default: transparent. JPEG's default transparency fill is black; background alpha is ignored for JPEG. |
| `signal` | Cancel local processing through `processImage`, or the storage operation through upload/download options. |

## Node adapter

```sh
npm install sharp
```

```ts
import { createClient } from "nostrbase";
import { SharpImageProcessor } from "nostrbase/node";

const db = createClient({
  namespace: "my-app",
  relays: ["wss://your-relay.example"],
  storage: { imageProcessor: new SharpImageProcessor() },
});
const { data, error } = await db.storage.processImage(file, { width: 800 });
```

The browser entry does not import Sharp or its native dependencies. Apps can also supply an `ImageProcessor` with the same contract. An adapter must return a `Blob` of supported raster bytes. A custom adapter is application code and must honor its own decode, resource, and cancellation limits.

## Limits and errors

Input and output Blob size is limited to 32 MiB; image dimensions are limited to 40 megapixels. Common raster headers are checked before decode. Decoding and encoding still need memory and CPU. The browser codec controls color handling and resampling. A browser that cannot encode a requested format returns `INVALID_CONFIG`; it does not silently return PNG. In Node, Sharp supplies the three formats.

Invalid options return `INVALID_QUERY`. Unsupported, malformed, or oversized images return `INVALID_RECORD`. Cancellation returns `ABORTED`; closing the client prevents a pending result from being exposed. Native browser decode/encode work may finish before cancellation is checked. Node processing stops its active Sharp operation. SVG, GIF, AVIF, animated-image preservation, CDN URLs, and server-side transformations are not part of this API. Raster processing emits a static image.
