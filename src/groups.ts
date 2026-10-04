import type {
  GroupPublishResult,
  MarmotGroup,
  StoredInviteEntry,
  StoredKeyPackage,
} from "@internet-privacy/marmot-ts/client";
import {
  createApplicationMessageIntent,
  MarmotClient,
  Proposals,
} from "@internet-privacy/marmot-ts/client";
import type { SerializedClientState } from "@internet-privacy/marmot-ts/core";
import {
  deserializeApplicationRumor,
  getGroupMemberPubkeys,
} from "@internet-privacy/marmot-ts/core";
import { createGiftWrap } from "@internet-privacy/marmot-ts/utils";
import type { VerifiedEvent } from "applesauce-core/helpers";
import type { Subscription } from "rxjs";
import type { NostrbaseClient } from "./client";
import { NostrbaseError } from "./errors";
import type { GroupOutboxEntry } from "./group-network";
import { GroupNetwork } from "./group-network";
import type { GroupRecordEntry, GroupRecordRumor } from "./group-records";
import {
  GroupRecordJournal,
  groupRecordDeletionTemplate,
  groupRecordRumor,
  groupRecordTable,
  groupRecordTemplate,
  parseGroupRecordRumor,
} from "./group-records";
import type { GroupPublicationRecord } from "./group-recovery";
import { GroupDurability, GroupPublicationPersistenceError } from "./group-recovery";
import type { GroupStateAdapter } from "./group-store";
import { EncryptedGroupStore, MemoryGroupStateAdapter } from "./group-store";
import {
  addressOf,
  compareEvents,
  decodeRecord,
  isObject,
  recordIdentifier,
  rowData,
  verify,
} from "./protocol";
import type { QueryHost, QueryState } from "./query";
import { applyQuery, nextCursor, parseCursor, QueryBuilder } from "./query";
import type {
  ChangePayload,
  DefaultSchema,
  NostrEvent,
  Result,
  ResultMeta,
  Row,
  SchemaShape,
  Signer,
  WriteReceipt,
} from "./types";

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
const randomId = (): string => hex(crypto.getRandomValues(new Uint8Array(32)));
/** Encrypted device-local storage. Reuse the device id and adapter across restarts. */
export interface GroupsOptions {
  deviceId?: string;
  adapter?: GroupStateAdapter;
}
export interface CreatePrivateGroupOptions {
  name: string;
  description?: string;
}
export interface PrivateGroupInfo {
  id: string;
  name: string;
  description: string;
  members: string[];
  admins: string[];
  status: "active" | "removed" | "disbanded";
  epoch: bigint;
}
export interface PrivateGroupInvite {
  id: string;
  author: string;
  name: string | null;
  description: string | null;
  joinable: boolean;
}
export type GroupChangePayload<T extends object> = ChangePayload<T> & { groupId: string };
interface SignedGroupIntent {
  groupId: string;
  table: string;
  recordId: string;
  rumor: GroupRecordRumor;
  proof: NostrEvent;
  createdAt: number;
  envelopeId?: string;
}
interface GroupContext<DB extends SchemaShape<DB>> {
  account: string;
  revision: number;
  engine: MarmotClient<undefined, undefined>;
  network: GroupNetwork;
  durability: GroupDurability;
  intents: EncryptedGroupStore<SignedGroupIntent>;
  ingress: EncryptedGroupStore<GroupRecordEntry>;
  welcomes: EncryptedGroupStore<NostrEvent>;
  projections: Map<string, GroupRecordJournal>;
  handles: Map<string, NostrbaseGroup<DB>>;
  pendingApplication: Map<string, GroupRecordRumor>;
  envelopes: Map<string, string>;
  receipts: Map<string, WriteReceipt>;
  welcomeAttempts: { groupId: string; eventId: string }[];
  guard(): Promise<void>;
  projection(groupId: string): Promise<GroupRecordJournal>;
  closed: boolean;
}
/** Shared private collections using the pinned Marmot engine. */
export class NostrbaseGroups<DB extends SchemaShape<DB> = DefaultSchema> {
  readonly deviceId: string;
  private readonly adapter: GroupStateAdapter;
  private readonly ownsAdapter: boolean;
  private context?: GroupContext<DB>;
  private initialization?: Promise<GroupContext<DB>>;
  private closed = false;
  private closing?: Promise<void>;
  private authSubscription: { unsubscribe(): void };
  constructor(
    readonly host: NostrbaseClient<DB>,
    options: GroupsOptions = {},
  ) {
    if (options.adapter && !options.deviceId)
      throw new NostrbaseError(
        "INVALID_CONFIG",
        "Set a stable random 64-hex deviceId when configuring group storage.",
      );
    this.deviceId = options.deviceId ?? randomId();
    if (!/^[0-9a-f]{64}$/.test(this.deviceId))
      throw new NostrbaseError(
        "INVALID_CONFIG",
        "Group deviceId must be a random 64-hex identifier.",
      );
    this.adapter = options.adapter ?? new MemoryGroupStateAdapter();
    this.ownsAdapter = !options.adapter;
    this.authSubscription = host.auth.onAuthStateChange(() => {
      if (this.context && this.context.revision !== host.auth.revision) this.disposeContext();
    }).data.subscription;
  }
  private disposeContext(): void {
    const context = this.context;
    this.context = undefined;
    if (!context) return;
    context.closed = true;
    context.network.close();
    for (const handle of context.handles.values()) handle.dispose();
    for (const group of context.engine.groups.loaded) group.dispose();
    context.durability.close();
    for (const projection of context.projections.values()) projection.close();
    context.projections.clear();
    context.handles.clear();
    context.pendingApplication.clear();
  }
  private async runtime(): Promise<GroupContext<DB>> {
    this.host.assertOpen();
    if (this.closed) throw new NostrbaseError("CLIENT_CLOSED", "Group manager is closed.");
    if (this.context) {
      await this.context.guard();
      return this.context;
    }
    if (this.initialization) return this.initialization;
    const initialization = this.initialize();
    this.initialization = initialization;
    try {
      return await initialization;
    } finally {
      if (this.initialization === initialization) this.initialization = undefined;
    }
  }
  private async initialize(): Promise<GroupContext<DB>> {
    await this.host.ready();
    const { signer, session } = await this.host.auth.requireSigner();
    if (!signer.nip44)
      throw new NostrbaseError("AUTH_FAILED", "Private groups require signer NIP-44 encryption.");
    const revision = this.host.auth.revision;
    const account = session.user.pubkey;
    const nip44 = signer.nip44;
    const guard = async (): Promise<void> => {
      this.host.assertOpen();
      if (this.closed) throw new NostrbaseError("CLIENT_CLOSED", "Group manager is closed.");
      if (revision !== this.host.auth.revision)
        throw new NostrbaseError(
          "AUTH_FAILED",
          "The group signer changed. Open the group with the current account.",
        );
      const current = await this.host.auth.requireSigner();
      if (
        current.signer !== signer ||
        current.session.user.pubkey !== account ||
        revision !== this.host.auth.revision
      )
        throw new NostrbaseError("AUTH_FAILED", "The group signer changed.");
      if ((await signer.getPublicKey()) !== account || revision !== this.host.auth.revision)
        throw new NostrbaseError("AUTH_FAILED", "The signer selected another account.");
    };
    const capturedSigner: Signer = {
      getPublicKey: async () => {
        await guard();
        return account;
      },
      signEvent: async (template) => {
        await guard();
        const event = await this.host.sign(template, account);
        await guard();
        return event;
      },
      nip44: {
        encrypt: async (key, value) => {
          await guard();
          const result = await nip44.encrypt(key, value);
          await guard();
          return result;
        },
        decrypt: async (key, value) => {
          await guard();
          const result = await nip44.decrypt(key, value);
          await guard();
          return result;
        },
      },
    };
    const store = <T>(bucket: string): EncryptedGroupStore<T> =>
      new EncryptedGroupStore<T>(
        this.adapter,
        { namespace: this.host.namespace, account, device: this.deviceId, bucket },
        capturedSigner,
        guard,
      );
    const groupStateStore = store<SerializedClientState>("state");
    const rewindStore = store<Uint8Array>("history");
    let durability: GroupDurability;
    const receipts = new Map<string, WriteReceipt>();
    const network = new GroupNetwork(
      {
        transport: this.host.transport,
        relays: this.host.relays,
        timeout: this.host.timeout,
        minWriteAcks: this.host.minWriteAcks,
        guard,
        signal: (signal) => this.host.signal(signal),
        afterPublish: async (event, response) => {
          const receipt = network.receipt(event.id);
          if (receipt) receipts.set(event.id, receipt);
          await durability.recordResponse(event, response);
        },
      },
      store<GroupOutboxEntry>("outbox"),
    );
    const projections = new Map<string, GroupRecordJournal>();
    const projection = async (groupId: string): Promise<GroupRecordJournal> => {
      await guard();
      let result = projections.get(groupId);
      if (!result) {
        result = new GroupRecordJournal(
          this.host.namespace,
          groupId,
          store<GroupRecordEntry>(`records:${groupId}`),
          (table) => {
            this.host.assertTable(table);
            return this.host.definition(table);
          },
          () => {
            this.host.assertOpen();
            if (this.closed || revision !== this.host.auth.revision)
              throw new NostrbaseError("AUTH_FAILED", "The group signer changed.");
          },
        );
        projections.set(groupId, result);
      }
      await result.ready();
      await guard();
      return result;
    };
    const intents = store<SignedGroupIntent>("intents");
    const ingress = store<GroupRecordEntry>("pending-ingress");
    const welcomes = store<NostrEvent>("welcome-envelopes");
    const pendingApplication = new Map<string, GroupRecordRumor>();
    const envelopes = new Map<string, string>();
    durability = new GroupDurability({
      journal: store<GroupPublicationRecord>("publications"),
      stateStore: groupStateStore,
      rewindStore,
      network,
      guard,
      application: async (group, work) => {
        if (work.kind !== "applicationMessage") return undefined;
        const rumor = pendingApplication.get(group.idStr);
        if (!rumor)
          throw new NostrbaseError(
            "INVALID_RECORD",
            "Group publication has no signed application intent.",
          );
        envelopes.set(rumor.id, work.envelope.id);
        return {
          rumor,
          stateTag: hex(group.state.confirmationTag),
          epoch: group.state.groupContext.epoch,
        };
      },
      prepared: async (record) => {
        if (!record.application) return;
        const intent = await intents.getItem(record.application.rumor.id);
        if (intent)
          await intents.setItem(record.application.rumor.id, {
            ...intent,
            envelopeId: record.envelope.id,
          });
      },
      onPublication: async (record) => {
        if (!record.application || !Object.values(record.response ?? {}).some((value) => value.ok))
          return;
        const { rumor, stateTag, epoch } = record.application;
        const parsed = parseGroupRecordRumor(rumor);
        if (!parsed)
          throw new NostrbaseError("INVALID_RECORD", "Recovered group record intent is invalid.");
        const journal = await projection(record.groupId);
        await journal.admit({
          rumor,
          rumorId: rumor.id,
          stateTag,
          epoch,
          sender: rumor.pubkey,
          ...parsed,
        });
        await intents.removeItem(rumor.id);
      },
    });
    const engine = new MarmotClient<undefined, undefined>({
      signer: capturedSigner,
      network,
      groupStateStore,
      rewindStore,
      keyPackageStore: store<StoredKeyPackage>("keypackages"),
      inviteStore: store<StoredInviteEntry>("invites"),
      ingestStateStore: store<Uint8Array>("ingest"),
      lifecycleStore: store<Uint8Array>("lifecycle"),
      removedMarkerStore: store<boolean>("removed"),
      clientId: this.deviceId,
      verifyEvent: (event): event is VerifiedEvent => verify(event),
    });
    const context: GroupContext<DB> = {
      account,
      revision,
      engine,
      network,
      durability,
      intents,
      ingress,
      welcomes,
      projections,
      handles: new Map(),
      pendingApplication,
      envelopes,
      receipts,
      welcomeAttempts: [],
      guard,
      projection,
      closed: false,
    };
    this.context = context;
    try {
      await durability.recover();
      await guard();
      return context;
    } catch (error) {
      this.disposeContext();
      throw groupError(error);
    }
  }
  private async handle(context: GroupContext<DB>, group: MarmotGroup): Promise<NostrbaseGroup<DB>> {
    await context.guard();
    let result = context.handles.get(group.idStr);
    if (!result) {
      const journal = await context.projection(group.idStr);
      context.durability.install(group);
      result = new NostrbaseGroup(this.host, context, group, journal);
      context.handles.set(group.idStr, result);
      await result.ready();
    }
    return result;
  }
  async create(options: CreatePrivateGroupOptions): Promise<NostrbaseGroup<DB>> {
    if (
      !options ||
      typeof options.name !== "string" ||
      !options.name.trim() ||
      options.name.length > 256 ||
      (options.description !== undefined &&
        (typeof options.description !== "string" || options.description.length > 4096))
    )
      throw new NostrbaseError("INVALID_QUERY", "Set a group name with 1 to 256 characters.");
    const context = await this.runtime();
    const group = await context.engine.groups.create(options.name, {
      description: options.description,
      relays: this.host.relays,
      adminPubkeys: [context.account],
    });
    return this.handle(context, group);
  }
  async get(id: string): Promise<NostrbaseGroup<DB>> {
    if (!/^[0-9a-f]{64}$/.test(id))
      throw new NostrbaseError("INVALID_QUERY", "Group id must be full hex.");
    const context = await this.runtime();
    if (!(await context.engine.groups.has(id)))
      throw new NostrbaseError("NOT_FOUND", "Private group is not stored on this device.");
    return this.handle(context, await context.engine.groups.get(id));
  }
  async list(): Promise<PrivateGroupInfo[]> {
    const context = await this.runtime();
    const output: PrivateGroupInfo[] = [];
    for (const group of await context.engine.groups.loadAll())
      output.push((await this.handle(context, group)).info);
    return output;
  }
  /** Publish the public device KeyPackage and discovery lists on configured relays. */
  async publishKeyPackage(): Promise<Result<WriteReceipt[]>> {
    const receipts: WriteReceipt[] = [];
    try {
      const context = await this.runtime();
      for (const kind of [10002, 10050]) {
        const event = await this.host.sign(
          {
            kind,
            created_at: Math.floor(Date.now() / 1000),
            content: "",
            tags: this.host.relays.map((url) => [kind === 10002 ? "r" : "relay", url]),
          },
          context.account,
        );
        await context.network.publish(this.host.relays, event);
        const result = context.network.receiptResult(event.id);
        if (result.data) receipts.push(result.data);
        if (result.error) throw result.error;
      }
      const keyPackage = await context.engine.keyPackages.create({
        relays: this.host.relays,
        identifier: this.deviceId,
        client: "nostrbase",
      });
      const stored = await context.engine.keyPackages.get(keyPackage.keyPackageRef);
      for (const event of stored?.published ?? []) {
        const result = context.network.receiptResult(event.id);
        if (result.data) receipts.push(result.data);
        if (result.error) throw result.error;
      }
      return receiptList(receipts);
    } catch (error) {
      return receiptList(receipts, groupError(error));
    }
  }
  async invites(): Promise<PrivateGroupInvite[]> {
    const context = await this.runtime();
    const events = await context.network.request(this.host.relays, {
      kinds: [1059],
      "#p": [context.account],
    });
    await context.engine.invites.ingestEvents(events);
    await context.engine.invites.decryptGiftWraps();
    const result: PrivateGroupInvite[] = [];
    for (const invite of await context.engine.invites.getUnread()) {
      const preview = await context.engine.previewWelcome(invite);
      await context.guard();
      result.push({
        id: invite.id,
        author: invite.pubkey,
        name: preview.group?.name ?? null,
        description: preview.group?.description ?? null,
        joinable: await context.engine.canJoinInvite(invite),
      });
    }
    return result;
  }
  async join(inviteId: string): Promise<NostrbaseGroup<DB>> {
    const context = await this.runtime();
    const invite = (await context.engine.invites.getUnread()).find(
      (value) => value.id === inviteId,
    );
    if (!invite)
      throw new NostrbaseError("NOT_FOUND", "Load the private group invitation before joining.");
    const preview = await context.engine.previewWelcome(invite);
    if (!preview.group?.adminPubkeys.includes(invite.pubkey))
      throw new NostrbaseError("PERMISSION_DENIED", "Invitation must be sent by a group admin.");
    if (preview.relays.some((url) => !this.host.relays.includes(new URL(url).toString())))
      throw new NostrbaseError(
        "PERMISSION_DENIED",
        "Configure the invitation's relays before joining.",
      );
    const { group } = await context.engine.joinGroupFromWelcome({ welcomeRumor: invite });
    const handle = await this.handle(context, group);
    await context.engine.invites.markAsRead(inviteId);
    const sync = await handle.sync();
    if (sync.error) throw sync.error;
    // Marmot requires a leaf update after accepting a Welcome.
    const update = await handle.rotate();
    if (update.error) throw update.error;
    return handle;
  }
  /** Retry exact envelopes and outstanding Welcomes; no new ciphertext is made. */
  async flush(): Promise<Result<WriteReceipt[]>> {
    const receipts: WriteReceipt[] = [];
    try {
      const context = await this.runtime();
      const welcomeStart = context.welcomeAttempts.length;
      const all = await context.durability.list();
      const unresolved = all.filter((record) => record.status !== "applied");
      const ids = [...new Set(unresolved.map((record) => record.groupId))];
      for (const id of ids) {
        context.handles.get(id)?.dispose();
        context.handles.delete(id);
        context.projections.get(id)?.close();
        context.projections.delete(id);
        await context.engine.groups.unload(id);
      }
      await context.durability.recover();
      const result = await context.network.flushPending();
      receipts.push(...(result.data ?? []));
      const welcomeIds = (await context.durability.pendingWelcomes()).map(
        (record) => record.groupId,
      );
      for (const id of new Set([...ids, ...welcomeIds]))
        await this.handle(context, await context.engine.groups.get(id));
      let failure = result.error;
      for (const group of context.engine.groups.loaded) {
        const outcomes = await context.durability.deliverWelcomes(group);
        if (outcomes.some((value) => value.kind === "failed"))
          failure ??= new NostrbaseError(
            "PUBLISH_FAILED",
            "Private group Welcome delivery still needs retry.",
          );
      }
      for (const attempt of context.welcomeAttempts.slice(welcomeStart)) {
        const publication = context.network.receiptResult(attempt.eventId);
        if (publication.data && !receipts.some((value) => value.eventId === attempt.eventId))
          receipts.push(publication.data);
        failure ??= publication.error;
      }
      return receiptList(receipts, failure);
    } catch (error) {
      receipts.push(...failureReceipts(error));
      return receiptList(receipts, groupError(error));
    }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.authSubscription.unsubscribe();
    this.disposeContext();
    this.closing = (async () => {
      await this.initialization?.catch(() => {});
      if (this.ownsAdapter) await this.adapter.close();
    })();
    void this.closing.catch(() => {});
  }
  async closeAsync(): Promise<void> {
    this.close();
    await this.closing;
  }
}

function groupError(error: unknown): NostrbaseError {
  // Crypto and signer errors can contain private payloads. Only public SDK errors escape.
  if (error instanceof NostrbaseError && error.code === "AUTH_FAILED")
    return new NostrbaseError("AUTH_FAILED", "Private group signer is unavailable or changed.");
  return error instanceof NostrbaseError
    ? error
    : new NostrbaseError("RELAY_ERROR", "Private group operation failed.");
}
function failureReceipts(error: unknown): WriteReceipt[] {
  if (!(error instanceof GroupPublicationPersistenceError)) return [];
  return error.publications.map((value) => ({
    id: value.eventId,
    eventId: value.eventId,
    relays: Object.values(value.response ?? {}).map((response) => ({
      url: response.from,
      ok: response.ok,
      message: response.message,
    })),
  }));
}
function receiptList(
  receipts: WriteReceipt[],
  error: NostrbaseError | null = null,
): Result<WriteReceipt[]> {
  return {
    data: receipts,
    error,
    count: receipts.length,
    meta: {
      relays: receipts.flatMap((value) => value.relays),
      receipts,
      partial: !!error || receipts.some((value) => value.relays.some((relay) => !relay.ok)),
    },
  };
}

/** A private Marmot scope with the same awaitable query builder as public tables. */
export class NostrbaseGroup<DB extends SchemaShape<DB> = DefaultSchema> implements QueryHost {
  readonly id: string;
  private lock: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private stream?: Subscription;
  private listeners = new Set<{
    table: string;
    callback: (change: GroupChangePayload<object>) => void;
    onError?: (error: NostrbaseError) => void;
  }>();
  private observed = new Map<string, Row<object>>();
  private stateSaved = () => {
    if (!this.disposed)
      void this.serial(() => this.finalizeIngress()).catch((error) =>
        this.report(groupError(error)),
      );
  };
  constructor(
    private host: NostrbaseClient<DB>,
    private context: GroupContext<DB>,
    private group: MarmotGroup,
    private journal: GroupRecordJournal,
  ) {
    this.id = group.idStr;
    const delivery = group.runtime.welcomeDelivery;
    delivery.deliver = async (options) => {
      await this.guard();
      const rumor = delivery.createRumor(options);
      const fingerprint = hex(
        new Uint8Array(
          await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(
              JSON.stringify([
                options.author,
                options.recipient.pubkey,
                options.recipient.keyPackageEventId,
                rumor.content,
              ]),
            ),
          ),
        ),
      );
      const key = `${this.id}/${fingerprint}`;
      let envelope = await this.context.welcomes.getItem(key);
      if (!envelope) {
        envelope = await createGiftWrap({
          rumor,
          recipient: options.recipient.pubkey,
          signer: delivery.signer,
        });
        await this.context.welcomes.setItem(key, envelope);
      }
      if (
        !verify(envelope) ||
        envelope.kind !== 1059 ||
        envelope.tags.filter((tag) => tag[0] === "p").length !== 1 ||
        !envelope.tags.some((tag) => tag[0] === "p" && tag[1] === options.recipient.pubkey)
      )
        throw new NostrbaseError("INVALID_RECORD", "Stored Welcome envelope is invalid.");
      let relays: string[];
      try {
        relays = await delivery.network.getUserInboxRelays(options.recipient.pubkey);
      } catch {
        relays = options.groupRelays;
      }
      await this.guard();
      this.context.welcomeAttempts.push({ groupId: this.id, eventId: envelope.id });
      return delivery.network.publish(relays, envelope);
    };
    group.session.beforeIngestResult = async (result) => {
      if (result.kind !== "processed" || result.result.kind !== "applicationMessage") return;
      try {
        const rumor = deserializeApplicationRumor(result.result.message);
        const parsed = parseGroupRecordRumor(rumor, this.host.namespace, this.id);
        if (!parsed) return;
        await this.context.ingress.setItem(
          `${this.id}/${rumor.id}/${hex(result.result.newState.confirmationTag)}`,
          {
            rumor,
            rumorId: rumor.id,
            sender: rumor.pubkey,
            stateTag: hex(result.result.newState.confirmationTag),
            epoch: result.result.newState.groupContext.epoch,
            ...parsed,
          },
        );
        await this.guard();
      } catch (error) {
        // A failed WAL must not leave a consumed in-memory ratchet available for a later save.
        this.dispose();
        this.context.handles.delete(this.id);
        this.context.projections.delete(this.id);
        await this.context.engine.groups.unload(this.id);
        throw error;
      }
    };
    group.on("stateSaved", this.stateSaved);
  }
  /** Complete any encrypted receive journal left by an interrupted ingress. */
  async ready(): Promise<void> {
    await this.guard();
    await this.finalizeIngress();
  }
  private async guard(): Promise<void> {
    await this.context.guard();
    if (this.disposed || this.context.closed)
      throw new NostrbaseError("AUTH_FAILED", "Private group handle is no longer active.");
  }
  private tags(): ReadonlySet<string> {
    const tip = hex(this.group.state.confirmationTag);
    return new Set(this.group.forkTree.path(tip) ?? [tip]);
  }
  get info(): PrivateGroupInfo {
    this.host.assertOpen();
    if (this.disposed || this.context.revision !== this.host.auth.revision)
      throw new NostrbaseError("AUTH_FAILED", "Private group handle is no longer active.");
    const data = this.group.groupData;
    return {
      id: this.id,
      name: data?.name ?? "",
      description: data?.description ?? "",
      members: getGroupMemberPubkeys(this.group.state),
      admins: [...(data?.adminPubkeys ?? [])],
      status: this.group.status,
      epoch: this.group.state.groupContext.epoch,
    };
  }
  from<K extends keyof DB & string>(table: K): QueryBuilder<DB[K]> {
    this.host.assertTable(table);
    return new QueryBuilder<DB[K]>(this, table);
  }
  private serial<T>(callback: () => Promise<T>): Promise<T> {
    const result = this.lock.then(async () => {
      await this.guard();
      return callback();
    });
    this.lock = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  private filter() {
    const routing = this.group.groupData?.nostrGroupId;
    if (!routing)
      throw new NostrbaseError("INVALID_RECORD", "Private group has no Nostr routing id.");
    return { kinds: [445], "#h": [hex(routing)] };
  }
  private async ingest(events: NostrEvent[]): Promise<void> {
    for await (const _result of this.group.ingest(events)) {
      await this.guard();
    }
    await this.group.save(true);
    await this.guard();
    await this.finalizeIngress();
  }
  private async finalizeIngress(): Promise<void> {
    await this.guard();
    const members = new Set(getGroupMemberPubkeys(this.group.state));
    for (const key of await this.context.ingress.keys()) {
      if (!key.startsWith(`${this.id}/`)) continue;
      const entry = await this.context.ingress.getItem(key);
      if (!entry) continue;
      if (
        !this.journal.has(entry.rumorId, entry.stateTag) &&
        members.has(entry.sender) &&
        (entry.type !== "snapshot" || this.group.groupData?.adminPubkeys.includes(entry.sender))
      ) {
        try {
          await this.journal.admit(entry);
        } catch (error) {
          if (
            !(
              error instanceof NostrbaseError &&
              ["INVALID_RECORD", "INVALID_QUERY", "PERMISSION_DENIED"].includes(error.code)
            )
          )
            throw error;
        }
      }
      await this.context.ingress.removeItem(key);
    }
    await this.guard();
    this.notify();
  }
  private async pull(): Promise<void> {
    await this.guard();
    await this.ingest(await this.context.network.request(this.host.relays, this.filter()));
  }
  async sync(): Promise<Result<PrivateGroupInfo>> {
    try {
      return await this.serial(async () => {
        await this.pull();
        return { data: this.info, error: null };
      });
    } catch (error) {
      return { data: null, error: groupError(error) };
    }
  }
  private active(): void {
    if (
      this.group.status !== "active" ||
      !getGroupMemberPubkeys(this.group.state).includes(this.context.account)
    )
      throw new NostrbaseError("PERMISSION_DENIED", "Only current group members can write.");
  }
  private admin(): void {
    this.active();
    if (!this.group.groupData?.adminPubkeys.includes(this.context.account))
      throw new NostrbaseError("PERMISSION_DENIED", "Only group admins can change membership.");
  }
  private publications(results: GroupPublishResult[]): Result<WriteReceipt[]> {
    const receipts: WriteReceipt[] = [];
    let failure: NostrbaseError | null = null;
    for (const publication of results) {
      const result = this.context.network.receiptResult(publication.work.envelope.id);
      if (result.data) receipts.push(result.data);
      failure ??= result.error;
      if (
        publication.persistence.kind === "failed" ||
        (publication.welcomeDelivery.kind === "attempted" &&
          publication.welcomeDelivery.outcomes.some((value) => value.kind === "failed"))
      )
        failure ??= new NostrbaseError(
          "PUBLISH_FAILED",
          "Group change was accepted, but local persistence or invitation delivery is incomplete.",
        );
    }
    return receiptList(receipts, failure);
  }
  private async sendRumor(rumor: GroupRecordRumor): Promise<Result<WriteReceipt[]>> {
    await this.guard();
    this.active();
    this.context.pendingApplication.set(this.id, rumor);
    try {
      const publications = await this.context.engine.groups.send(
        this.id,
        createApplicationMessageIntent(rumor),
      );
      await this.guard();
      this.notify();
      return this.publications(publications);
    } catch (error) {
      const id = this.context.envelopes.get(rumor.id);
      const receipt = id ? this.context.network.receipt(id) : undefined;
      const failure =
        error instanceof NostrbaseError
          ? error
          : id
            ? (this.context.network.receiptResult(id).error ?? groupError(error))
            : groupError(error);
      return receiptList(receipt ? [receipt] : [], failure);
    } finally {
      this.context.pendingApplication.delete(this.id);
    }
  }
  async invite(pubkey: string): Promise<Result<WriteReceipt[]>> {
    const receipts: WriteReceipt[] = [];
    const welcomeStart = this.context.welcomeAttempts.length;
    const collect = (): NostrbaseError | null => {
      let failure: NostrbaseError | null = null;
      for (const attempt of this.context.welcomeAttempts
        .slice(welcomeStart)
        .filter((value) => value.groupId === this.id)) {
        const result = this.context.network.receiptResult(attempt.eventId);
        if (result.data && !receipts.some((value) => value.eventId === attempt.eventId))
          receipts.push(result.data);
        failure ??= result.error;
      }
      return failure;
    };
    try {
      return await this.serial(async () => {
        await this.pull();
        this.admin();
        if (!/^[0-9a-f]{64}$/.test(pubkey))
          throw new NostrbaseError("INVALID_QUERY", "Invite a full hex public key.");
        const packages = await this.context.network.request(this.host.relays, {
          kinds: [30443],
          authors: [pubkey],
        });
        const keyPackage = packages
          .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))
          .find((event) => this.group.evaluateKeyPackage(event).eligible);
        if (!keyPackage)
          throw new NostrbaseError(
            "NOT_FOUND",
            "Recipient must publish a compatible Marmot KeyPackage first.",
          );
        // Use the engine facade; it checks the account proof and enforces admin policy.
        const before = new Set(
          (await this.context.durability.list(this.id)).map((record) => record.envelope.id),
        );
        await this.context.engine.groups.invite(this.id, keyPackage);
        for (const value of await this.context.durability.list(this.id))
          if (value.kind === "groupEvolution" && value.response && !before.has(value.envelope.id)) {
            const result = this.context.network.receiptResult(value.envelope.id);
            if (result.data) receipts.push(result.data);
            if (result.error) throw result.error;
          }
        // New members lack past epoch secrets. Send verifiable proofs in the current epoch.
        const proofs = this.journal.proofs(this.tags());
        for (let offset = 0; offset < proofs.length; offset += 100) {
          const rumor = groupRecordRumor(
            this.host.namespace,
            this.id,
            "snapshot",
            proofs.slice(offset, offset + 100),
            this.context.account,
            Math.floor(Date.now() / 1000),
          );
          const result = await this.sendRumor(rumor);
          receipts.push(...(result.data ?? []));
          if (result.error) throw result.error;
        }
        const pending = await this.context.durability.pendingWelcomes(this.id);
        if (pending.length)
          throw new NostrbaseError(
            "PUBLISH_FAILED",
            "Membership was accepted; invitation delivery needs retry.",
            pending,
          );
        return receiptList(receipts, collect());
      });
    } catch (error) {
      collect();
      receipts.push(
        ...failureReceipts(error).filter(
          (value) => !receipts.some((receipt) => receipt.eventId === value.eventId),
        ),
      );
      return receiptList(receipts, groupError(error));
    }
  }
  async remove(pubkey: string): Promise<Result<WriteReceipt[]>> {
    try {
      return await this.serial(async () => {
        await this.pull();
        this.admin();
        if (!/^[0-9a-f]{64}$/.test(pubkey) || pubkey === this.context.account)
          throw new NostrbaseError(
            "INVALID_QUERY",
            "Remove another member by full hex public key.",
          );
        if (!getGroupMemberPubkeys(this.group.state).includes(pubkey))
          throw new NostrbaseError("NOT_FOUND", "Account is not a current group member.");
        const result = await this.context.engine.groups.send(this.id, {
          kind: "commit",
          actorPubkey: this.context.account,
          extraProposals: [
            await Proposals.proposeRemoveUser(pubkey)(this.group.session.proposalContext()),
          ],
        });
        this.notify();
        return this.publications(result);
      });
    } catch (error) {
      return receiptList(failureReceipts(error), groupError(error));
    }
  }
  async rotate(): Promise<Result<WriteReceipt[]>> {
    try {
      return await this.serial(async () => {
        this.active();
        return this.publications(
          await this.context.engine.groups.send(this.id, { kind: "selfUpdate" }),
        );
      });
    } catch (error) {
      return receiptList(failureReceipts(error), groupError(error));
    }
  }
  async leave(): Promise<Result<WriteReceipt[]>> {
    try {
      return await this.serial(async () => {
        await this.pull();
        this.active();
        const effects = await this.group.session.leave(this.context.account);
        const result = this.publications(await this.group.runtime.publishEffects(effects));
        if (!result.error) this.dispose();
        return result;
      });
    } catch (error) {
      return receiptList(failureReceipts(error), groupError(error));
    }
  }
  subscribe<K extends keyof DB & string>(
    table: K,
    callback: (change: GroupChangePayload<DB[K]>) => void,
    onError?: (error: NostrbaseError) => void,
  ): { unsubscribe(): void } {
    this.host.assertTable(table);
    if (this.disposed)
      throw new NostrbaseError("AUTH_FAILED", "Private group handle is no longer active.");
    const listener = {
      table,
      callback: callback as (change: GroupChangePayload<object>) => void,
      onError,
    };
    this.listeners.add(listener);
    this.seed(table);
    if (!this.stream) {
      this.stream = this.context.network.subscription(this.host.relays, this.filter()).subscribe({
        next: (event) => {
          void this.serial(() => this.ingest([event])).catch((error) =>
            this.report(groupError(error)),
          );
        },
        error: (error) => this.report(groupError(error)),
      });
      void this.sync().then((result) => {
        if (result.error) this.report(result.error);
      });
    }
    return {
      unsubscribe: () => {
        this.listeners.delete(listener);
        if (!this.listeners.size) {
          this.stream?.unsubscribe();
          this.stream = undefined;
          this.observed.clear();
        }
      },
    };
  }
  private key(table: string, row: Row<object>): string {
    return JSON.stringify([table, row._nostr.pubkey, row.id]);
  }
  private seed(table: string): void {
    for (const row of this.journal.rows(table, this.tags()))
      this.observed.set(this.key(table, row), row);
  }
  private report(error: NostrbaseError): void {
    for (const listener of this.listeners)
      try {
        listener.onError?.(error);
      } catch {
        /* Isolate observers. */
      }
  }
  private notify(): void {
    if (this.disposed || !this.listeners.size) return;
    const current = new Map<string, Row<object>>();
    for (const table of new Set([...this.listeners].map((value) => value.table)))
      for (const row of this.journal.rows(table, this.tags()))
        current.set(this.key(table, row), row);
    for (const listener of this.listeners)
      for (const key of new Set([...this.observed.keys(), ...current.keys()])) {
        if (JSON.parse(key)[0] !== listener.table) continue;
        const old = this.observed.get(key) ?? null;
        const row = current.get(key) ?? null;
        if (old?._nostr.eventId === row?._nostr.eventId) continue;
        const changed = row ?? old;
        if (!changed) continue;
        const proof = this.journal.proof(changed._nostr.eventId);
        if (!proof) continue;
        try {
          listener.callback(
            structuredClone({
              groupId: this.id,
              table: listener.table,
              eventType: row ? (old ? "UPDATE" : "INSERT") : "DELETE",
              new: row,
              old,
              event: proof,
            }),
          );
        } catch {
          /* Isolate observers. */
        }
      }
    this.observed = current;
  }
  async execute<T extends object>(table: string, state: QueryState): Promise<Result<Row<T>[]>> {
    try {
      return await this.serial(async () => {
        this.host.assertTable(table);
        if (this.host.signal(state.signal).aborted)
          throw new NostrbaseError("ABORTED", "Group operation was aborted.");
        const cursor = parseCursor(state.page?.cursor);
        if (
          cursor &&
          (cursor.namespace !== `${this.host.namespace}:group:${this.id}` || cursor.table !== table)
        )
          throw new NostrbaseError("INVALID_QUERY", "Cursor belongs to another table or group.");
        if (!state.local) await this.pull();
        if (state.operation === "select") {
          const rows = applyQuery(
            this.journal
              .rows<T>(table, this.tags())
              .filter((row) => !state.authors || state.authors.includes(row._nostr.pubkey)),
            state,
          );
          return {
            data: rows,
            error: null,
            count: rows.length,
            meta: {
              relays: [],
              partial: false,
              cached: !!state.local,
              nextCursor: nextCursor(`${this.host.namespace}:group:${this.id}`, table, rows, state),
            },
          };
        }
        return this.mutate<T>(table, state);
      });
    } catch (error) {
      return { data: null, error: groupError(error) };
    }
  }
  private async mutate<T extends object>(
    table: string,
    state: QueryState,
  ): Promise<Result<Row<T>[]>> {
    const committed: Row<T>[] = [];
    const receipts: WriteReceipt[] = [];
    const meta: ResultMeta = { relays: [], partial: false, receipts, queued: !!state.queue };
    try {
      this.active();
      const account = this.context.account;
      if (state.authors?.some((author) => author !== account))
        throw new NostrbaseError("PERMISSION_DENIED", "You can only write your own records.");
      let owned = this.journal
        .rows<T>(table, this.tags())
        .filter((row) => row._nostr.pubkey === account);
      const pending: SignedGroupIntent[] = [];
      for (const key of await this.context.intents.keys()) {
        const intent = await this.context.intents.getItem(key);
        if (intent?.groupId === this.id && intent.table === table) pending.push(intent);
      }
      const known = [...this.journal.proofs(this.tags()), ...pending.map((intent) => intent.proof)];
      const ownedMap = new Map(owned.map((row) => [row.id, row]));
      for (const intent of pending.sort((a, b) => compareEvents(a.proof, b.proof))) {
        const proof = intent.proof;
        if (!verify(proof) || proof.pubkey !== account)
          throw new NostrbaseError("INVALID_RECORD", "Queued group proof is invalid.");
        if (proof.kind === 5) {
          const row = ownedMap.get(intent.recordId);
          if (row && row._nostr.updatedAt <= proof.created_at) ownedMap.delete(intent.recordId);
        } else {
          const row = decodeRecord<T>(
            proof,
            this.host.namespace,
            groupRecordTable(this.id, table),
            this.host.definition(table),
          );
          if (!row) throw new NostrbaseError("INVALID_RECORD", "Queued group record is invalid.");
          ownedMap.set(row.id, row);
        }
      }
      owned = [...ownedMap.values()];
      const writes: { id: string; data: T; previous?: Row<T>; proof?: NostrEvent }[] = [];
      if (state.operation === "insert" || state.operation === "upsert") {
        if (!state.values?.length)
          throw new NostrbaseError("INVALID_RECORD", "Insert at least one record.");
        const seen = new Set<string>();
        for (const input of state.values) {
          if (!isObject(input))
            throw new NostrbaseError("INVALID_RECORD", "Record must be an object.");
          const { id: providedId, ...data } = input;
          const id = providedId === undefined ? crypto.randomUUID() : providedId;
          if (typeof id !== "string" || !id || id.length > 512)
            throw new NostrbaseError(
              "INVALID_RECORD",
              "Record id must contain 1 to 512 characters.",
            );
          if (seen.has(id))
            throw new NostrbaseError("CONFLICT", "A batch cannot contain duplicate ids.");
          seen.add(id);
          const previous = owned.find((row) => row.id === id);
          if (previous && state.operation === "insert")
            throw new NostrbaseError("CONFLICT", "Record exists. Use upsert to replace it.");
          groupRecordTemplate(
            this.host.namespace,
            this.id,
            table,
            id,
            data,
            0,
            0,
            this.host.definition(table),
          );
          writes.push({ id, data: data as T, previous });
        }
      } else {
        if (!state.predicates.length && !state.allowAll)
          throw new NostrbaseError("INVALID_QUERY", "Filter updates and deletes, or call all().");
        if (
          state.operation === "update" &&
          (!isObject(state.patch) || "id" in state.patch || "_nostr" in state.patch)
        )
          throw new NostrbaseError(
            "INVALID_RECORD",
            "Update data must be an object. id and _nostr cannot be changed.",
          );
        for (const previous of applyQuery(owned, state)) {
          const data = { ...rowData(previous), ...state.patch } as T;
          if (state.operation === "update")
            groupRecordTemplate(
              this.host.namespace,
              this.id,
              table,
              previous.id,
              data,
              0,
              0,
              this.host.definition(table),
            );
          writes.push({
            id: previous.id,
            data,
            previous,
            proof:
              this.journal.proof(previous._nostr.eventId) ??
              pending.find((intent) => intent.proof.id === previous._nostr.eventId)?.proof,
          });
        }
      }
      for (const write of writes) {
        await this.guard();
        if (this.host.signal(state.signal).aborted)
          throw new NostrbaseError("ABORTED", "Group operation was aborted.");
        const timestamp = Math.max(
          Math.floor(Date.now() / 1000),
          (write.previous?._nostr.updatedAt ?? -1) + 1,
          ...known
            .filter(
              (proof) =>
                proof.pubkey === account &&
                (proof.kind === 30078
                  ? addressOf(proof) ===
                    `30078:${account}:${recordIdentifier(this.host.namespace, groupRecordTable(this.id, table), write.id)}`
                  : proof.tags.some(
                      (tag) =>
                        tag[0] === "a" &&
                        tag[1] ===
                          `30078:${account}:${recordIdentifier(this.host.namespace, groupRecordTable(this.id, table), write.id)}`,
                    )),
            )
            .map((proof) => proof.created_at + 1),
        );
        if (state.operation === "delete" && !write.proof)
          throw new NostrbaseError("INVALID_RECORD", "Deletion has no author-signed record proof.");
        const template =
          state.operation === "delete"
            ? groupRecordDeletionTemplate(
                this.host.namespace,
                this.id,
                table,
                write.proof ? [write.proof] : [],
                timestamp,
              )
            : groupRecordTemplate(
                this.host.namespace,
                this.id,
                table,
                write.id,
                write.data,
                write.previous?._nostr.createdAt ?? timestamp,
                timestamp,
                this.host.definition(table),
              );
        const proof = await this.host.sign(template, account);
        known.push(proof);
        await this.guard();
        const rumor = groupRecordRumor(
          this.host.namespace,
          this.id,
          "record",
          [proof],
          account,
          timestamp,
        );
        const intent: SignedGroupIntent = {
          groupId: this.id,
          table,
          recordId: write.id,
          rumor,
          proof,
          createdAt: Date.now(),
        };
        await this.context.intents.setItem(rumor.id, intent);
        if (state.queue) {
          receipts.push({ id: write.id, eventId: proof.id, relays: [], queued: true });
        } else {
          const result = await this.sendRumor(rumor);
          for (const receipt of result.data ?? []) {
            const item = { ...receipt, id: write.id };
            receipts.push(item);
            meta.relays.push(...item.relays);
          }
          if (result.data?.some((receipt) => receipt.relays.some((relay) => relay.ok))) {
            const row =
              state.operation === "delete"
                ? write.previous
                : decodeRecord<T>(
                    proof,
                    this.host.namespace,
                    groupRecordTable(this.id, table),
                    this.host.definition(table),
                  );
            if (row) committed.push(row);
          }
          if (result.error) throw result.error;
          continue;
        }
        const row =
          state.operation === "delete"
            ? write.previous
            : decodeRecord<T>(
                proof,
                this.host.namespace,
                groupRecordTable(this.id, table),
                this.host.definition(table),
              );
        if (row) committed.push(row);
      }
      meta.partial = meta.relays.some((relay) => !relay.ok);
      return {
        data: state.returning ? committed : null,
        error: null,
        count: committed.length,
        meta,
      };
    } catch (error) {
      meta.partial = committed.length > 0 || receipts.length > 0;
      return {
        data: state.returning ? committed : null,
        error: groupError(error),
        count: committed.length,
        meta,
      };
    }
  }
  /** Catch up membership, then encrypt queued signed record intents for the current epoch. */
  async flush(): Promise<Result<WriteReceipt[]>> {
    const receipts: WriteReceipt[] = [];
    try {
      return await this.serial(async () => {
        await this.pull();
        this.active();
        for (const key of await this.context.intents.keys()) {
          const intent = await this.context.intents.getItem(key);
          if (!intent || intent.groupId !== this.id) continue;
          if (intent.envelopeId)
            throw new NostrbaseError(
              "CONFLICT",
              "An existing encrypted publication needs db.groups.flush() and device recovery before another send.",
            );
          if (!verify(intent.proof) || intent.proof.pubkey !== this.context.account)
            throw new NostrbaseError("INVALID_RECORD", "Queued group record signature is invalid.");
          const result = await this.sendRumor(intent.rumor);
          receipts.push(...(result.data ?? []).map((value) => ({ ...value, id: intent.recordId })));
          if (result.error) throw result.error;
        }
        return receiptList(receipts);
      });
    } catch (error) {
      return receiptList(receipts, groupError(error));
    }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stream?.unsubscribe();
    this.stream = undefined;
    this.listeners.clear();
    this.observed.clear();
    this.group.dispose();
    this.group.off("stateSaved", this.stateSaved);
    this.group.session.beforeIngestResult = undefined;
    this.journal.close();
  }
}
