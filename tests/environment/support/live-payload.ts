import { deflateSync } from "node:zlib";

/** Tiny, unique synthetic fixtures with truthful MIME types and deterministic byte identity. */
export function livePayload(format: string, marker: string) {
  if (format === "text")
    return { name: "integration.txt", type: "text/plain", bytes: Buffer.from(marker) };
  if (format === "json")
    return {
      name: "integration.json",
      type: "application/json",
      bytes: Buffer.from(JSON.stringify({ source: "nostrbase integration", marker })),
    };
  if (format !== "png") throw new Error("NOSTRBASE_LIVE_BLOB_FORMAT must be text, json, or png.");
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    let checksum = 0xffffffff;
    for (const byte of body) {
      checksum ^= byte;
      for (let bit = 0; bit < 8; bit++)
        checksum = (checksum >>> 1) ^ (checksum & 1 ? 0xedb88320 : 0);
    }
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE((checksum ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6; // Eight-bit RGBA, one opaque black pixel.
  const bytes = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("tEXt", Buffer.from(`Comment\0${marker}`, "utf8")),
    chunk("IDAT", deflateSync(Buffer.from([0, 0, 0, 0, 255]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return { name: "integration.png", type: "image/png", bytes };
}
