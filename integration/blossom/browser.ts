import { createClient, PrivateKeySigner } from "../../src";

/** Run the SDK with browser fetch: no Node HTTP client can satisfy this check. */
export async function roundTrip(server: string) {
  const owner = createClient({
    namespace: "blossom-browser",
    relays: ["ws://127.0.0.1:1"],
    signer: new PrivateKeySigner(new Uint8Array(32).fill(63)),
  });
  const foreign = createClient({
    namespace: "blossom-browser",
    relays: ["ws://127.0.0.1:1"],
    signer: new PrivateKeySigner(new Uint8Array(32).fill(64)),
  });
  try {
    const bucket = owner.storage.from(server);
    const input = "Browser CORS: signed storage round trip ✓";
    const uploaded = await bucket.upload("browser.txt", new Blob([input], { type: "text/plain" }));
    if (!uploaded.data || uploaded.error)
      throw new Error(`Browser upload failed: ${uploaded.error?.message}`);
    const hash = uploaded.data.sha256;
    const listed = await bucket.list();
    const downloaded = await bucket.download(hash);
    const forbidden = await foreign.storage.from(server).remove([hash]);
    const removed = await bucket.remove([hash]);
    const absent = await bucket.download(hash);
    return {
      hash,
      size: uploaded.data.size,
      inputSize: new TextEncoder().encode(input).byteLength,
      listed: listed.data?.some((blob) => blob.sha256 === hash),
      listError: listed.error?.code ?? null,
      download: await downloaded.data?.text(),
      downloadError: downloaded.error?.code ?? null,
      expected: input,
      foreignDelete: forbidden.data?.[0]?.error?.code,
      removed: removed.data?.[0]?.ok,
      removeError: removed.error?.code ?? null,
      absent: absent.error?.code,
    };
  } finally {
    await Promise.all([owner.closeAsync(), foreign.closeAsync()]);
  }
}
