import type { Signer } from "nostrbase";
import { createClient } from "nostrbase";
import { SharpImageProcessor } from "nostrbase/node";

export async function resizeAndUpload(file: Blob, relay: string, server: string, signer: Signer) {
  const db = createClient({
    namespace: "image-example",
    relays: [relay],
    signer,
    storage: { imageProcessor: new SharpImageProcessor() },
  });
  try {
    const result = await db.storage.from(server).upload("thumbnail.webp", file, {
      transform: { width: 256, height: 256, resize: "cover", format: "webp", quality: 85 },
    });
    if (result.error) throw result.error;
    return result.data;
  } finally {
    await db.closeAsync();
  }
}
