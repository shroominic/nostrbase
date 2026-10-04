import type {
  GroupEffects,
  GroupPublishResult,
  GroupPublishWork,
  MarmotGroup,
  NostrNetworkInterface,
  PublishResponse,
  WelcomeDeliveryOutcome,
} from "@internet-privacy/marmot-ts/client";
import { deserializeClientState, serializeClientState } from "@internet-privacy/marmot-ts/core";
import type { SerializedClientState } from "@internet-privacy/marmot-ts/core";
import { GroupHistoryTree } from "@internet-privacy/marmot-ts/engine";
import type { OwnCommitConvergenceStamp } from "@internet-privacy/marmot-ts/engine";
import {
  decode,
  encode,
  mlsMessageDecoder,
  mlsMessageEncoder,
} from "@internet-privacy/marmot-ts/mls";
import { NostrbaseError } from "./errors";
import type { EncryptedGroupStore, GroupStoreIdentityGuard } from "./group-store";
import { verify } from "./protocol";
import type { NostrEvent } from "./types";

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
const equalBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);
export interface GroupApplicationPublication {
  rumor: Omit<NostrEvent, "sig">;
  stateTag: string;
  epoch: bigint;
}
export interface GroupPublicationRecord {
  version: 1;
  groupId: string;
  sequence: number;
  status: "prepared" | "published" | "applied";
  kind: GroupPublishWork["kind"];
  envelope: NostrEvent;
  relays: string[];
  /** Engine state after sending, including consumed application generations. */
  postState: SerializedClientState;
  baselineState?: SerializedClientState;
  /** Local plaintext/proof metadata is stored only inside the encrypted WAL. */
  application?: GroupApplicationPublication;
  pending?: {
    kind: "proposal" | "commit" | "selfUpdate";
    newState: SerializedClientState;
    parentState?: SerializedClientState;
    commitBytes?: Uint8Array;
    ownCommitStamp?: OwnCommitConvergenceStamp;
  };
  welcomeBytes?: Uint8Array;
  actorPubkey?: string;
  recipients?: Extract<GroupPublishWork, { kind: "groupEvolution" }>["welcomeRecipients"];
  response?: Record<string, PublishResponse>;
  result?: Omit<GroupPublishResult, "work">;
  /** Recipient public keys still requiring a Welcome. */
  pendingRecipients?: string[];
}
export interface GroupPublicationSummary {
  groupId: string;
  eventId: string;
  kind: GroupPublicationRecord["kind"];
  status: GroupPublicationRecord["status"];
  response?: Record<string, PublishResponse>;
  pendingWelcomes: number;
}
export interface GroupDurabilityOptions {
  journal: EncryptedGroupStore<GroupPublicationRecord>;
  stateStore: EncryptedGroupStore<SerializedClientState>;
  rewindStore: EncryptedGroupStore<Uint8Array>;
  network: NostrNetworkInterface;
  guard: GroupStoreIdentityGuard;
  /** Persist the caller's confirmed application projection before marking work applied. */
  onPublication?: (record: GroupPublicationRecord) => void | Promise<void>;
  /** Link caller intents only after the exact encrypted WAL has been saved. */
  prepared?: (record: GroupPublicationRecord) => void | Promise<void>;
  /** Attach the caller's durable local rumor/proof to the exact prepared envelope. */
  application?: (
    group: MarmotGroup,
    work: GroupPublishWork,
  ) => GroupApplicationPublication | undefined | Promise<GroupApplicationPublication | undefined>;
}
/** Contains public receipts only. Private MLS state never enters error details. */
export class GroupPublicationPersistenceError extends NostrbaseError {
  constructor(readonly publications: GroupPublicationSummary[]) {
    super(
      "PUBLISH_FAILED",
      "Group publication may be accepted, but durable completion failed. Recover the existing publication before sending another operation.",
      publications,
    );
  }
}
function summary(record: GroupPublicationRecord): GroupPublicationSummary {
  return {
    groupId: record.groupId,
    eventId: record.envelope.id,
    kind: record.kind,
    status: record.status,
    response: record.response,
    pendingWelcomes: record.pendingRecipients?.length ?? 0,
  };
}

/** WAL for the pinned Marmot public session/runtime seams. All stores are self-encrypted. */
export class GroupDurability {
  private installed = new Map<MarmotGroup, () => void>();
  private baselines = new Map<string, Uint8Array>();
  constructor(private options: GroupDurabilityOptions) {}
  private async guard(): Promise<void> {
    await this.options.guard();
  }
  private key(record: Pick<GroupPublicationRecord, "groupId" | "envelope">): string {
    return `${record.groupId}/${record.envelope.id}`;
  }
  private async save(record: GroupPublicationRecord): Promise<void> {
    await this.guard();
    await this.options.journal.setItem(this.key(record), record);
    await this.guard();
  }
  async list(groupId?: string): Promise<GroupPublicationRecord[]> {
    await this.guard();
    const records: GroupPublicationRecord[] = [];
    const keys = await this.options.journal.keys();
    for (const key of keys) {
      await this.guard();
      if (groupId && !key.startsWith(`${groupId}/`)) continue;
      const record = await this.options.journal.getItem(key);
      if (!record) continue;
      if (
        record.version !== 1 ||
        !verify(record.envelope) ||
        this.key(record) !== key ||
        !/^[0-9a-f]{64}$/.test(record.groupId) ||
        !["prepared", "published", "applied"].includes(record.status)
      )
        throw new NostrbaseError("INVALID_RECORD", "Group recovery record is invalid.");
      records.push(record);
    }
    await this.guard();
    return records.sort(
      (a, b) => a.sequence - b.sequence || a.envelope.id.localeCompare(b.envelope.id),
    );
  }
  /** Mandatory network hook: persist actual ACKs before returning them to Marmot. */
  async recordResponse(
    envelope: NostrEvent,
    response: Record<string, PublishResponse>,
  ): Promise<boolean> {
    await this.guard();
    const keys = await this.options.journal.keys();
    const key = keys.find((value) => value.endsWith(`/${envelope.id}`));
    if (!key) return false;
    const record = await this.options.journal.getItem(key);
    if (!record || record.envelope.id !== envelope.id) return false;
    record.response = structuredClone(response);
    if (Object.values(response).some((value) => value.ok) && record.status === "prepared")
      record.status = "published";
    await this.save(record);
    return true;
  }
  install(group: MarmotGroup): () => void {
    const existing = this.installed.get(group);
    if (existing) return existing;
    const originalPublish = group.runtime.publishEffects;
    const originalSend = group.session.send;
    const originalLeave = group.session.leave;
    const helper = this;
    group.session.send = async function (intent) {
      await helper.guard();
      if ((await helper.list(group.idStr)).some((record) => record.status !== "applied"))
        throw new NostrbaseError(
          "CONFLICT",
          "Recover the group's pending publication before preparing another operation.",
        );
      const baseline = serializeClientState(group.state);
      const effects = await originalSend.call(this, intent);
      await helper.guard();
      for (const work of effects.publish) helper.baselines.set(work.envelope.id, baseline.slice());
      return effects;
    };
    group.session.leave = async function (pubkey) {
      await helper.guard();
      if ((await helper.list(group.idStr)).some((record) => record.status !== "applied"))
        throw new NostrbaseError(
          "CONFLICT",
          "Recover the group's pending publication before preparing another operation.",
        );
      const baseline = serializeClientState(group.state);
      const effects = await originalLeave.call(this, pubkey);
      await helper.guard();
      for (const work of effects.publish) helper.baselines.set(work.envelope.id, baseline.slice());
      return effects;
    };
    group.runtime.publishEffects = async function (
      effects: GroupEffects,
    ): Promise<GroupPublishResult[]> {
      const results: GroupPublishResult[] = [];
      for (const work of effects.publish) {
        await helper.guard();
        const groupId = group.idStr;
        const prior = await helper.list(groupId);
        if (prior.some((record) => record.status !== "applied")) {
          if ("pending" in work) group.session.publishFailed(work.pending);
          throw new NostrbaseError(
            "CONFLICT",
            "Recover the group's pending publication before publishing another operation.",
          );
        }
        const record: GroupPublicationRecord = {
          version: 1,
          groupId,
          sequence: prior.reduce(
            (latest, value) => Math.max(latest, value.sequence + 1),
            Date.now(),
          ),
          status: "prepared",
          kind: work.kind,
          envelope: structuredClone(work.envelope),
          relays: [...(group.relays ?? [])],
          postState: serializeClientState(group.state),
          baselineState: helper.baselines.get(work.envelope.id),
        };
        helper.baselines.delete(work.envelope.id);
        if ("pending" in work)
          record.pending = {
            kind: work.pending.kind,
            newState: serializeClientState(work.pending.newState),
            parentState: work.pending.parentState
              ? serializeClientState(work.pending.parentState)
              : undefined,
            commitBytes: work.pending.commitMessage
              ? encode(mlsMessageEncoder, work.pending.commitMessage)
              : undefined,
            ownCommitStamp: work.pending.ownCommitStamp
              ? structuredClone(work.pending.ownCommitStamp)
              : undefined,
          };
        if (work.kind === "groupEvolution") {
          record.welcomeBytes = work.welcome ? encode(mlsMessageEncoder, work.welcome) : undefined;
          record.actorPubkey = work.actorPubkey;
          record.recipients = structuredClone(work.welcomeRecipients);
          record.pendingRecipients = work.welcomeRecipients?.map((value) => value.pubkey);
        }
        try {
          if (work.kind === "applicationMessage" && helper.options.application) {
            await helper.guard();
            record.application = structuredClone(await helper.options.application(group, work));
            await helper.guard();
          }
          await helper.save(record);
          await helper.guard();
          await helper.options.prepared?.(structuredClone(record));
          await helper.guard();
          // Applications consume their own sender generation before publication. A
          // relay echo cannot reconstruct it after the consumed secret is erased.
          await group.save(true);
          await helper.guard();
        } catch (error) {
          // No envelope has reached the network. Reset the live commit lifecycle
          // so the pending WAL guard rejects new sends instead of queueing forever.
          if ("pending" in work) group.session.publishFailed(work.pending);
          throw error;
        }
        let publication: GroupPublishResult | undefined;
        try {
          [publication] = await originalPublish.call(this, { publish: [work] });
          if (!publication) throw new Error("Missing publication result");
          record.response = structuredClone(publication.response);
          if (!Object.values(publication.response).some((value) => value.ok)) {
            await helper.save(record);
            throw new NostrbaseError(
              "PUBLISH_FAILED",
              "Group publication has no relay acknowledgement.",
              summary(record),
            );
          }
          record.status = "published";
          const { work: _work, ...outcome } = publication;
          record.result = structuredClone(outcome);
          if (publication.welcomeDelivery.kind === "attempted")
            record.pendingRecipients = publication.welcomeDelivery.outcomes
              .filter((value) => value.kind === "failed")
              .map((value) => value.recipient.pubkey);
          await helper.save(record);
          if (publication.persistence.kind === "failed")
            throw new GroupPublicationPersistenceError([summary(record)]);
          await helper.guard();
          await helper.options.onPublication?.(structuredClone(record));
          await helper.guard();
          record.status = "applied";
          await helper.save(record);
          results.push(publication);
        } catch (error) {
          // Never include a pending state, payload, signer error, or MLS secret
          // in a public error. An unknown ACK retains the same exact envelope.
          if (
            results.length > 0 ||
            (publication && Object.values(publication.response).some((value) => value.ok)) ||
            error instanceof GroupPublicationPersistenceError
          )
            throw new GroupPublicationPersistenceError([
              ...results.map((value) => ({
                groupId,
                eventId: value.work.envelope.id,
                kind: value.work.kind,
                status: "applied" as const,
                response: value.response,
                pendingWelcomes: 0,
              })),
              summary(record),
            ]);
          throw error;
        }
      }
      return results;
    };
    const uninstall = (): void => {
      group.runtime.publishEffects = originalPublish;
      group.session.send = originalSend;
      group.session.leave = originalLeave;
      this.installed.delete(group);
    };
    this.installed.set(group, uninstall);
    return uninstall;
  }
  private async restore(record: GroupPublicationRecord): Promise<void> {
    await this.guard();
    const currentBytes = await this.options.stateStore.getItem(record.groupId);
    const current = currentBytes ? deserializeClientState(currentBytes) : undefined;
    if (record.pending?.kind === "commit" || record.pending?.kind === "selfUpdate") {
      const pending = record.pending;
      if (!pending.parentState || !pending.commitBytes)
        throw new NostrbaseError(
          "INVALID_RECORD",
          "Group recovery commit has no parent or commit bytes.",
        );
      const parent = deserializeClientState(pending.parentState);
      const child = deserializeClientState(pending.newState);
      const message = decode(mlsMessageDecoder, pending.commitBytes);
      if (
        !message ||
        hex(child.groupContext.groupId) !== record.groupId ||
        hex(parent.groupContext.groupId) !== record.groupId
      )
        throw new NostrbaseError(
          "INVALID_RECORD",
          "Group recovery state does not match its group.",
        );
      await this.guard();
      let tree = await GroupHistoryTree.load(this.options.rewindStore, record.groupId);
      if (!tree) {
        tree = new GroupHistoryTree(parent);
        tree.bindStore(this.options.rewindStore);
      }
      const parentTag = hex(parent.confirmationTag);
      if (!tree.hasNode(parentTag))
        throw new NostrbaseError(
          "CONFLICT",
          "Group recovery commit parent is missing from retained history.",
        );
      tree.recordCommit(
        parentTag,
        message,
        child,
        Number(parent.privatePath.leafIndex),
        pending.ownCommitStamp,
      );
      await this.guard();
      await tree.flush();
      await this.guard();
      // A newer canonical state remains the tip. Adding our stamped branch lets
      // the real engine choose between forks when the group is loaded.
      if (!current || hex(current.confirmationTag) === parentTag) {
        await this.options.stateStore.setItem(record.groupId, pending.newState);
        await this.guard();
      }
    } else {
      const target = record.pending?.newState ?? record.postState;
      const state = deserializeClientState(target);
      if (hex(state.groupContext.groupId) !== record.groupId)
        throw new NostrbaseError(
          "INVALID_RECORD",
          "Group recovery state does not match its group.",
        );
      // If another operation already advanced the same epoch's ratchet, do not
      // replace it with an older generation. The WAL captures the pre-send state.
      if (
        !currentBytes ||
        (record.baselineState && equalBytes(currentBytes, record.baselineState))
      ) {
        await this.guard();
        if (record.pending?.kind === "proposal") {
          let tree = await GroupHistoryTree.load(this.options.rewindStore, record.groupId);
          if (!tree) {
            tree = new GroupHistoryTree(current ?? state);
            tree.bindStore(this.options.rewindStore);
          }
          tree.updateSnapshot(hex(state.confirmationTag), state);
          await this.guard();
          await tree.flush();
          await this.guard();
        }
        await this.options.stateStore.setItem(record.groupId, target);
        await this.guard();
      }
    }
  }
  /** Run before GroupsManager.get/loadAll and before accepting inbound traffic. */
  async recover(groupId?: string): Promise<GroupPublicationSummary[]> {
    const output: GroupPublicationSummary[] = [];
    for (const record of await this.list(groupId)) {
      await this.guard();
      if (record.status === "applied") {
        output.push(summary(record));
        continue;
      }
      if (record.status === "prepared") {
        const response = await this.options.network.publish(
          record.relays,
          structuredClone(record.envelope),
        );
        await this.guard();
        record.response = structuredClone(response);
        if (!Object.values(response).some((value) => value.ok))
          throw new NostrbaseError(
            "PUBLISH_FAILED",
            "Group recovery publication has no relay acknowledgement.",
            summary(record),
          );
        record.status = "published";
        await this.save(record);
      }
      if (!record.response || !Object.values(record.response).some((value) => value.ok))
        throw new NostrbaseError(
          "INVALID_RECORD",
          "Published group recovery record has no acknowledgement.",
        );
      try {
        await this.restore(record);
        await this.guard();
        await this.options.onPublication?.(structuredClone(record));
        await this.guard();
        record.status = "applied";
        await this.save(record);
      } catch {
        throw new GroupPublicationPersistenceError([summary(record)]);
      }
      output.push(summary(record));
    }
    return output;
  }
  async pendingWelcomes(groupId?: string): Promise<GroupPublicationSummary[]> {
    return (await this.list(groupId))
      .filter(
        (record) =>
          record.status === "applied" && record.welcomeBytes && record.pendingRecipients?.length,
      )
      .map(summary);
  }
  /** Retry post-commit Welcome fanout independently of the irreversible commit. */
  async deliverWelcomes(group: MarmotGroup): Promise<WelcomeDeliveryOutcome[]> {
    const outcomes: WelcomeDeliveryOutcome[] = [];
    if (group.status !== "active")
      throw new NostrbaseError("PERMISSION_DENIED", "An inactive group cannot retry Welcomes.");
    const members = new Set(group.info.members.pubkeys);
    const canonical = new Set(group.forkTree.path(hex(group.state.confirmationTag)) ?? []);
    for (const record of await this.list(group.idStr)) {
      if (
        record.status !== "applied" ||
        !record.welcomeBytes ||
        !record.actorPubkey ||
        !record.pendingRecipients?.length
      )
        continue;
      const message = decode(mlsMessageDecoder, record.welcomeBytes);
      if (!message || !("welcome" in message))
        throw new NostrbaseError("INVALID_RECORD", "Group recovery Welcome bytes are invalid.");
      if (
        record.pending?.newState &&
        !canonical.has(hex(deserializeClientState(record.pending.newState).confirmationTag))
      )
        continue;
      const recipients =
        record.recipients?.filter(
          (value) => record.pendingRecipients?.includes(value.pubkey) && members.has(value.pubkey),
        ) ?? [];
      if (!recipients.length) continue;
      await this.guard();
      const delivered = await group.runtime.welcomeDelivery.deliverMany({
        welcome: message.welcome,
        author: record.actorPubkey,
        groupRelays: record.relays,
        recipients,
      });
      await this.guard();
      record.pendingRecipients = delivered
        .filter((value) => value.kind === "failed")
        .map((value) => value.recipient.pubkey);
      await this.save(record);
      outcomes.push(...delivered);
    }
    return outcomes;
  }
  close(): void {
    for (const uninstall of [...this.installed.values()]) uninstall();
    this.baselines.clear();
  }
}
