import { describe, expect, it } from "vitest";
import type { NostrEvent } from "../src";
import { NostrbaseError } from "../src";
import {
  decodeRecord,
  encodeRecord,
  recordIdentifier,
  validateData,
  verify,
} from "../src/protocol";
import { alice } from "./helpers";

describe("record wire contract", () => {
  it("round-trips Unicode and delimiters without address collisions or JSON type loss", async () => {
    const namespace = "app:私/%";
    const table = "table:é/%";
    const id = "item:💾/%";
    const data = { text: "é", nil: null, active: false, count: 0, list: [1, { n: true }] };
    const signed = await alice.signEvent(encodeRecord(namespace, table, id, data, 10, 12));
    expect(verify(signed)).toBe(true);
    expect(decodeRecord(signed, namespace, table)).toEqual({
      ...data,
      id,
      _nostr: {
        pubkey: await alice.getPublicKey(),
        eventId: signed.id,
        createdAt: 10,
        updatedAt: 12,
      },
    });
    expect(recordIdentifier("a:b", "c", "d")).not.toBe(recordIdentifier("a", "b:c", "d"));
    expect(recordIdentifier("a", "b", "c:d")).not.toBe(recordIdentifier("a", "b:c", "d"));
  });

  it("encodes false, zero, null and structured indexes while omitting absent fields", () => {
    const wire = encodeRecord<{
      flag: boolean;
      n: number;
      nil: null;
      parts: string[];
      absent?: string;
    }>("app", "items", "x", { flag: false, n: 0, nil: null, parts: ["a:b"] }, 1, 2, {
      indexes: ["flag", "n", "nil", "parts", "absent"],
    });
    expect(wire.tags).toEqual([
      ["d", "nostrbase:app:items:x"],
      ["t", "nostrbase:app:items"],
      ["t", "nostrbase:app:items:flag:false"],
      ["t", "nostrbase:app:items:n:0"],
      ["t", "nostrbase:app:items:nil:null"],
      ["t", "nostrbase:app:items:parts:%5B%22a%3Ab%22%5D"],
    ]);
  });

  const invalidBodies: [string, (body: Record<string, unknown>) => void][] = [
    [
      "unknown protocol version",
      (body) => {
        body.v = 2;
      },
    ],
    [
      "content namespace disagrees with scope",
      (body) => {
        body.namespace = "foreign";
      },
    ],
    [
      "content table disagrees with scope",
      (body) => {
        body.table = "foreign";
      },
    ],
    [
      "content id disagrees with address",
      (body) => {
        body.id = "other";
      },
    ],
    [
      "empty id",
      (body) => {
        body.id = "";
      },
    ],
    [
      "oversized id",
      (body) => {
        body.id = "x".repeat(513);
      },
    ],
    [
      "negative creation time",
      (body) => {
        body.createdAt = -1;
      },
    ],
    [
      "fractional creation time",
      (body) => {
        body.createdAt = 1.5;
      },
    ],
    [
      "creation after update",
      (body) => {
        body.createdAt = 13;
      },
    ],
    [
      "reserved metadata in data",
      (body) => {
        body.data = { _nostr: {} };
      },
    ],
    [
      "non-object data",
      (body) => {
        body.data = [];
      },
    ],
  ];
  it.each(invalidBodies)("rejects signed records with %s", async (_name, corrupt) => {
    const template = encodeRecord("app", "items", "x", { n: 1 }, 10, 12);
    const body = JSON.parse(template.content) as Record<string, unknown>;
    corrupt(body);
    const signed = await alice.signEvent({ ...template, content: JSON.stringify(body) });
    expect(verify(signed)).toBe(true); // A valid signature does not imply a valid record.
    expect(decodeRecord(signed, "app", "items")).toBeNull();
  });

  it("rejects an incorrect first address, missing scope and invalid JSON independently of signature", async () => {
    const wire = encodeRecord("app", "items", "x", { n: 1 }, 10, 12);
    const variants = [
      { ...wire, tags: [["d", "wrong"], ...wire.tags] },
      { ...wire, tags: wire.tags.filter((tag) => tag[0] !== "t") },
      { ...wire, content: "{" },
    ];
    for (const variant of variants) {
      const signed = await alice.signEvent(variant);
      expect(verify(signed)).toBe(true);
      expect(decodeRecord(signed, "app", "items")).toBeNull();
    }
  });
});

describe("JSON and signature trust boundaries", () => {
  it.each([
    ["undefined", undefined],
    ["non-finite numbers", Number.POSITIVE_INFINITY],
    ["big integers", 1n],
    ["functions", () => 1],
    ["symbols", Symbol("x")],
    ["Date objects", new Date(0)],
    ["class instances", new Map()],
  ])("rejects nested %s before serialization can silently alter data", (_name, value) => {
    expect(() => validateData({ nested: [{ value }] })).toThrow(NostrbaseError);
  });

  it("rejects cycles but permits repeated references and plain objects without a prototype", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => validateData(cycle)).toThrow(/circular/);
    const value = Object.assign(Object.create(null), { n: 1 });
    expect(() => validateData({ a: value, b: value })).not.toThrow();
  });

  it.each(["kind", "created_at", "pubkey", "id", "sig", "tags", "content"] as const)(
    "rechecks the signed %s field rather than trusting caller verification state",
    async (field) => {
      const signed = await alice.signEvent({ kind: 1, created_at: 10, content: "hello", tags: [] });
      expect(verify(signed)).toBe(true);
      const altered = structuredClone(signed);
      const replacements = {
        kind: 2,
        created_at: 11,
        pubkey: "0".repeat(64),
        id: "0".repeat(64),
        sig: "0".repeat(128),
        tags: [["t", "changed"]],
        content: "changed",
      };
      Object.assign(altered, { [field]: replacements[field] });
      expect(verify(altered)).toBe(false);
    },
  );

  it("fails closed on malformed wire shapes without throwing", () => {
    for (const input of [
      null,
      {},
      { kind: -1 },
      { kind: 65536 },
      { kind: 1, created_at: -1 },
      { kind: 1, created_at: 1, tags: null },
    ])
      expect(verify(input as unknown as NostrEvent)).toBe(false);
  });
});
