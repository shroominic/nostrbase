import { getEventHash } from "nostr-tools";
import { NostrbaseError } from "./errors";
import type { EncryptedGroupStore } from "./group-store";
import {
  addressOf,
  compareEvents,
  decodeRecord,
  deletionTemplate,
  encodeRecord,
  isObject,
  RECORD_KIND,
  recordIdentifier,
  scopeTag,
  verify,
} from "./protocol";
import type { EventTemplate, NostrEvent, Row, TableDefinition } from "./types";

export const GROUP_RECORD_RUMOR_KIND = 30078;
export const MAX_GROUP_RECORD_PROOFS = 1000;
export interface GroupRecordRumor {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}
export interface GroupRecordEntry {
  rumor: GroupRecordRumor;
  rumorId: string;
  stateTag: string;
  epoch: bigint;
  sender: string;
  proofs: NostrEvent[];
  type: "record" | "snapshot";
}
interface RecordEnvelope {
  v: 1;
  namespace: string;
  groupId: string;
  type: GroupRecordEntry["type"];
  proofs: NostrEvent[];
}
type RecordStore = Pick<EncryptedGroupStore<GroupRecordEntry>, "getItem" | "setItem" | "keys">;
type Definition = (table: string) => TableDefinition<object> | undefined;
const invalid = (message = "Group record envelope is invalid.") =>
  new NostrbaseError("INVALID_RECORD", message);
function checkScope(namespace: string, groupId: string): void {
  if (
    typeof namespace !== "string" ||
    !namespace.trim() ||
    namespace.length > 256 ||
    !/^[0-9a-f]{64}$/.test(groupId)
  )
    throw new NostrbaseError(
      "INVALID_CONFIG",
      "Set a namespace and a lowercase 32-byte MLS group ID.",
    );
}
function checkTable(table: string): void {
  if (typeof table !== "string" || !table.trim() || table.length > 256)
    throw new NostrbaseError(
      "INVALID_QUERY",
      "Group table names must contain 1 to 256 characters.",
    );
}
export function groupRecordTable(groupId: string, table: string): string {
  if (!/^[0-9a-f]{64}$/.test(groupId))
    throw new NostrbaseError("INVALID_CONFIG", "MLS group ID must be lowercase 32-byte hex.");
  checkTable(table);
  return `group:${groupId}:${table}`;
}
function rumorScope(namespace: string, groupId: string): string {
  return `nostrbase-group-records:v1:${encodeURIComponent(namespace)}:${groupId}`;
}
export function groupRecordTemplate<T extends object>(
  namespace: string,
  groupId: string,
  table: string,
  id: string,
  data: T,
  createdAt: number,
  updatedAt: number,
  definition?: TableDefinition<T>,
): EventTemplate {
  checkScope(namespace, groupId);
  if (
    !Number.isSafeInteger(createdAt) ||
    createdAt < 0 ||
    !Number.isSafeInteger(updatedAt) ||
    updatedAt < createdAt
  )
    throw invalid("Group record timestamps are invalid.");
  return encodeRecord(
    namespace,
    groupRecordTable(groupId, table),
    id,
    data,
    createdAt,
    updatedAt,
    definition,
  );
}
export function groupRecordDeletionTemplate(
  namespace: string,
  groupId: string,
  table: string,
  events: NostrEvent[],
  timestamp: number,
): EventTemplate {
  checkScope(namespace, groupId);
  const route = groupRecordTable(groupId, table);
  if (
    !events.length ||
    events.length > MAX_GROUP_RECORD_PROOFS ||
    !Number.isSafeInteger(timestamp) ||
    timestamp < 0
  )
    throw invalid("Select 1 to 1000 group record proofs and a valid deletion timestamp.");
  for (const event of events)
    if (!verify(event) || !decodeRecord(event, namespace, route) || event.created_at > timestamp)
      throw invalid("Deletion target is not a verified record in this group table.");
  return deletionTemplate(namespace, route, events, timestamp);
}
function wireProof(proof: NostrEvent): NostrEvent {
  return {
    id: proof.id,
    pubkey: proof.pubkey,
    kind: proof.kind,
    created_at: proof.created_at,
    tags: structuredClone(proof.tags),
    content: proof.content,
    sig: proof.sig,
  };
}
function sameProofs(left: NostrEvent[], right: NostrEvent[]): boolean {
  try {
    return JSON.stringify(left.map(wireProof)) === JSON.stringify(right.map(wireProof));
  } catch {
    return false;
  }
}
export function groupRecordRumor(
  namespace: string,
  groupId: string,
  type: GroupRecordEntry["type"],
  proofs: NostrEvent[],
  sender: string,
  createdAt = Math.floor(Date.now() / 1000),
): GroupRecordRumor {
  checkScope(namespace, groupId);
  if (
    !/^[0-9a-f]{64}$/.test(sender) ||
    !Number.isSafeInteger(createdAt) ||
    createdAt < 0 ||
    !["record", "snapshot"].includes(type) ||
    !Array.isArray(proofs) ||
    proofs.length > MAX_GROUP_RECORD_PROOFS ||
    (type === "record" && !proofs.length)
  )
    throw invalid("Group record rumor sender, timestamp, or proof count is invalid.");
  const envelope: RecordEnvelope = {
    v: 1,
    namespace,
    groupId,
    type,
    proofs: proofs.map(wireProof),
  };
  const rumor: GroupRecordRumor = {
    id: "",
    pubkey: sender,
    kind: GROUP_RECORD_RUMOR_KIND,
    created_at: createdAt,
    tags: [["t", rumorScope(namespace, groupId)]],
    content: JSON.stringify(envelope),
  };
  rumor.id = getEventHash(rumor);
  return rumor;
}
function parseEnvelope(
  rumor: GroupRecordRumor,
  namespace?: string,
  groupId?: string,
): RecordEnvelope | null {
  try {
    const keys = ["id", "pubkey", "kind", "created_at", "tags", "content"];
    if (
      !isObject(rumor) ||
      Reflect.ownKeys(rumor).length !== keys.length ||
      keys.some((key) => !Object.hasOwn(rumor, key)) ||
      !/^[0-9a-f]{64}$/.test(rumor.id) ||
      !/^[0-9a-f]{64}$/.test(rumor.pubkey) ||
      rumor.kind !== GROUP_RECORD_RUMOR_KIND ||
      !Number.isSafeInteger(rumor.created_at) ||
      rumor.created_at < 0 ||
      typeof rumor.content !== "string" ||
      !Array.isArray(rumor.tags) ||
      rumor.tags.some(
        (tag) => !Array.isArray(tag) || tag.some((item) => typeof item !== "string"),
      ) ||
      getEventHash(rumor) !== rumor.id
    )
      return null;
    const value: unknown = JSON.parse(rumor.content);
    if (
      !isObject(value) ||
      Object.keys(value).length !== 5 ||
      value.v !== 1 ||
      typeof value.namespace !== "string" ||
      typeof value.groupId !== "string" ||
      !["record", "snapshot"].includes(value.type as string) ||
      !Array.isArray(value.proofs) ||
      value.proofs.length > MAX_GROUP_RECORD_PROOFS ||
      (value.type === "record" && !value.proofs.length)
    )
      return null;
    checkScope(value.namespace, value.groupId);
    if (
      (namespace !== undefined && value.namespace !== namespace) ||
      (groupId !== undefined && value.groupId !== groupId)
    )
      return null;
    if (
      rumor.tags.length !== 1 ||
      rumor.tags[0]?.length !== 2 ||
      rumor.tags[0]?.[0] !== "t" ||
      rumor.tags[0]?.[1] !== rumorScope(value.namespace, value.groupId)
    )
      return null;
    return value as unknown as RecordEnvelope;
  } catch {
    return null;
  }
}
export function parseGroupRecordRumor(
  rumor: GroupRecordRumor,
  namespace?: string,
  groupId?: string,
): { type: GroupRecordEntry["type"]; proofs: NostrEvent[] } | null {
  const envelope = parseEnvelope(rumor, namespace, groupId);
  return envelope ? { type: envelope.type, proofs: structuredClone(envelope.proofs) } : null;
}

/** Encrypted append-only projection journal. Membership/admin admission remains the parent's responsibility. */
export class GroupRecordJournal {
  private entries = new Map<string, GroupRecordEntry>();
  private hydration: Promise<void>;
  private closed = false;
  private lock: Promise<void> = Promise.resolve();
  constructor(
    private namespace: string,
    private groupId: string,
    private store: RecordStore,
    private definition: Definition = () => undefined,
    /** Synchronous account revision and client/group lifetime check. */
    private guard: () => void = () => {},
  ) {
    checkScope(namespace, groupId);
    this.hydration = this.hydrate();
    void this.hydration.catch(() => {});
  }
  private check(): void {
    if (this.closed) throw new NostrbaseError("CLIENT_CLOSED", "Group record journal is closed.");
    const guarded: unknown = this.guard();
    if (guarded && typeof (guarded as { then?: unknown }).then === "function") {
      void Promise.resolve(guarded).catch(() => {});
      throw new NostrbaseError(
        "INVALID_CONFIG",
        "Group record projection requires a synchronous identity guard.",
      );
    }
  }
  private storageKey(entry: GroupRecordEntry): string {
    return `${entry.rumorId}:${encodeURIComponent(entry.stateTag)}`;
  }
  private tableDefinition(table: string): TableDefinition<object> | undefined {
    try {
      return this.definition(table);
    } catch {
      throw invalid("Group record proof names an unknown or invalid table.");
    }
  }
  private proofTable(proof: NostrEvent): string {
    if (!verify(proof) || (proof.kind !== RECORD_KIND && proof.kind !== 5))
      throw invalid("Group record proof signature or kind is invalid.");
    if (proof.kind === RECORD_KIND) {
      let record: unknown;
      try {
        record = JSON.parse(proof.content);
      } catch {
        throw invalid("Group record proof content is invalid.");
      }
      const prefix = `group:${this.groupId}:`;
      if (!isObject(record) || typeof record.table !== "string" || !record.table.startsWith(prefix))
        throw invalid("Record proof belongs to another group.");
      const table = record.table.slice(prefix.length);
      checkTable(table);
      if (
        !decodeRecord(
          proof,
          this.namespace,
          groupRecordTable(this.groupId, table),
          this.tableDefinition(table),
        )
      )
        throw invalid("Record proof scope, data, or table schema is invalid.");
      return table;
    }
    const tagPrefix = scopeTag(this.namespace, `group:${this.groupId}:`);
    const tags = proof.tags.filter((tag) => tag[0] === "t");
    if (tags.length !== 1 || !tags[0]?.[1]?.startsWith(tagPrefix))
      throw invalid("Deletion proof must name one group table.");
    let table: string;
    try {
      table = decodeURIComponent(tags[0][1].slice(tagPrefix.length));
    } catch {
      throw invalid("Deletion proof table is invalid.");
    }
    checkTable(table);
    const route = groupRecordTable(this.groupId, table);
    if (tags[0][1] !== scopeTag(this.namespace, route))
      throw invalid("Deletion proof table encoding is invalid.");
    const pointers = proof.tags.filter((tag) => tag[0] === "a" || tag[0] === "e");
    if (!pointers.length) throw invalid("Deletion proof has no record pointers.");
    for (const tag of pointers) {
      if (tag[0] === "e") {
        if (!/^[0-9a-f]{64}$/.test(tag[1] ?? ""))
          throw invalid("Deletion event pointer is invalid.");
      } else {
        const prefix = `${RECORD_KIND}:${proof.pubkey}:${scopeTag(this.namespace, route)}:`;
        if (!tag[1]?.startsWith(prefix))
          throw invalid("Deletion address must belong to its author and group table.");
        let id: string;
        try {
          id = decodeURIComponent(tag[1].slice(prefix.length));
        } catch {
          throw invalid("Deletion address record ID is invalid.");
        }
        if (
          !id ||
          id.length > 512 ||
          tag[1] !== `${RECORD_KIND}:${proof.pubkey}:${recordIdentifier(this.namespace, route, id)}`
        )
          throw invalid("Deletion record address is invalid.");
      }
    }
    return table;
  }
  private validate(entry: GroupRecordEntry): void {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof entry.stateTag !== "string" ||
      !entry.stateTag ||
      entry.stateTag.length > 512 ||
      typeof entry.epoch !== "bigint" ||
      entry.epoch < 0n ||
      entry.rumorId !== entry.rumor?.id ||
      entry.sender !== entry.rumor?.pubkey
    )
      throw invalid("Group record admission metadata is invalid.");
    const envelope = parseEnvelope(entry.rumor, this.namespace, this.groupId);
    if (
      !envelope ||
      entry.type !== envelope.type ||
      !Array.isArray(entry.proofs) ||
      entry.proofs.length !== envelope.proofs.length ||
      !sameProofs(entry.proofs, envelope.proofs)
    )
      throw invalid("Group record proofs do not match their canonical rumor.");
    const seen = new Set<string>();
    let table: string | undefined;
    for (const proof of entry.proofs) {
      const current = this.proofTable(proof);
      if (seen.has(proof.id)) throw invalid("Group envelope cannot repeat a proof.");
      seen.add(proof.id);
      if (entry.type === "record") {
        if (proof.pubkey !== entry.sender)
          throw new NostrbaseError(
            "PERMISSION_DENIED",
            "Direct group record proofs must be signed by the MLS sender.",
          );
        if (table !== undefined && table !== current)
          throw invalid("Direct record envelope must affect one group table.");
        table = current;
      }
    }
  }
  private async hydrate(): Promise<void> {
    this.check();
    const keys = await this.store.keys();
    this.check();
    const restored = new Map<string, GroupRecordEntry>();
    for (const key of keys) {
      const entry = await this.store.getItem(key);
      this.check();
      if (entry === null) continue;
      this.validate(entry);
      if (key !== this.storageKey(entry))
        throw invalid("Persisted group record journal key does not match its entry.");
      restored.set(key, structuredClone(entry));
    }
    this.check();
    this.entries = restored;
  }
  async ready(): Promise<void> {
    await this.hydration;
    this.check();
  }
  async admit(input: GroupRecordEntry): Promise<boolean> {
    const entry = structuredClone(input);
    const previous = this.lock;
    let release = () => {};
    this.lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      await this.hydration;
      this.check();
      this.validate(entry);
      const key = this.storageKey(entry);
      const existing = this.entries.get(key);
      if (existing) {
        if (existing.epoch !== entry.epoch)
          throw invalid("A group state tag cannot admit the same rumor at two epochs.");
        return false;
      }
      await this.store.setItem(key, entry);
      this.check();
      this.entries.set(key, entry);
      return true;
    } finally {
      release();
    }
  }
  has(rumorId: string, stateTag?: string): boolean {
    this.check();
    return [...this.entries.values()].some(
      (entry) =>
        entry.rumorId === rumorId && (stateTag === undefined || entry.stateTag === stateTag),
    );
  }
  proof(eventId: string): NostrEvent | undefined {
    this.check();
    for (const entry of this.entries.values()) {
      const proof = entry.proofs.find((candidate) => candidate.id === eventId);
      if (proof) return structuredClone(proof);
    }
    return undefined;
  }
  proofs(activeTags: ReadonlySet<string>): NostrEvent[] {
    this.check();
    const proofs = new Map<string, NostrEvent>();
    for (const entry of this.entries.values())
      if (activeTags.has(entry.stateTag))
        for (const proof of entry.proofs) proofs.set(proof.id, proof);
    return structuredClone(
      [...proofs.values()].sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id)),
    );
  }
  rows<T extends object = object>(table: string, activeTags: ReadonlySet<string>): Row<T>[] {
    this.check();
    checkTable(table);
    const route = groupRecordTable(this.groupId, table);
    const records = new Map<string, NostrEvent>();
    const addresses = new Map<string, number>();
    const ids = new Map<string, number>();
    for (const proof of this.proofs(activeTags)) {
      if (this.proofTable(proof) !== table) continue;
      if (proof.kind === RECORD_KIND) {
        const address = addressOf(proof);
        const previous = records.get(address);
        if (!previous || compareEvents(proof, previous) > 0) records.set(address, proof);
      } else {
        for (const tag of proof.tags) {
          if (tag[0] === "a" && tag[1])
            addresses.set(tag[1], Math.max(addresses.get(tag[1]) ?? -1, proof.created_at));
          else if (tag[0] === "e" && tag[1]) {
            const key = `${proof.pubkey}:${tag[1]}`;
            ids.set(key, Math.max(ids.get(key) ?? -1, proof.created_at));
          }
        }
      }
    }
    const rows: Row<T>[] = [];
    for (const proof of records.values()) {
      if (
        (addresses.get(addressOf(proof)) ?? -1) >= proof.created_at ||
        (ids.get(`${proof.pubkey}:${proof.id}`) ?? -1) >= proof.created_at
      )
        continue;
      const row = decodeRecord<T>(
        proof,
        this.namespace,
        route,
        this.tableDefinition(table) as TableDefinition<T> | undefined,
      );
      if (row) rows.push(row);
    }
    return structuredClone(
      rows.sort(
        (a, b) =>
          b._nostr.updatedAt - a._nostr.updatedAt ||
          a._nostr.eventId.localeCompare(b._nostr.eventId),
      ),
    );
  }
  close(): void {
    this.closed = true;
    this.entries.clear();
  }
}
