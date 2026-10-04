export { EventStore } from "applesauce-core";
export { RelayPool } from "applesauce-relay";
export { ExtensionSigner, NostrConnectSigner, PrivateKeySigner } from "applesauce-signers";
export { NostrbaseAuth } from "./auth";
export type { Backup, BackupImport } from "./backup";
export { belongsToNamespace, NostrbaseBackup } from "./backup";
export type {
  BroadcastMessage,
  BroadcastPayload,
  ChannelOptions,
  PresenceMeta,
  PresencePayload,
  PresenceState,
} from "./channel";
export { NostrbaseChannel, REALTIME_KIND } from "./channel";
export { createClient, NostrbaseClient } from "./client";
export type { DashboardSnapshot } from "./dashboard";
export { NostrbaseDashboard } from "./dashboard";
export type { DiagnosticEntry, DiagnosticsOptions, DiagnosticType } from "./diagnostics";
export { NostrbaseDiagnostics } from "./diagnostics";
export type { ErrorCode } from "./errors";
export { NostrbaseError } from "./errors";
export { NostrbaseEvents } from "./events";
export type { MigrationOptions, MigrationResult } from "./migrations";
export { NostrbaseMigrations } from "./migrations";
export type { OfflineOptions, QueuedWriteReceipt } from "./offline";
export { NostrbaseOffline } from "./offline";
export type { PersistenceAdapter, PersistenceOptions, QueuedEvent } from "./persistence";
export {
  IndexedDBPersistenceAdapter,
  MemoryPersistenceAdapter,
  NostrbasePersistence,
} from "./persistence";
export { NostrbasePrivateTables } from "./private";
export { PROTOCOL_VERSION, RECORD_KIND, recordIdentifier, scopeTag } from "./protocol";
export { QueryBuilder } from "./query";
export type { RecordReference } from "./relations";
export { NostrbaseRelations, reference } from "./relations";
export type { InferDatabase } from "./schema";
export { defineSchema, defineTable, zodTable } from "./schema";
export type {
  BlobDescriptor,
  BlobRemoval,
  StorageDownloadOptions,
  StorageListOptions,
  StorageOptions,
  StorageRequestOptions,
  StoredBlob,
} from "./storage";
export { NostrbaseStorage } from "./storage";
export type { SyncMeta, SyncOptions, SyncPullOptions, SyncRelayResult, SyncResult } from "./sync";
export { NostrbaseSync } from "./sync";
export { ApplesauceTransport } from "./transport";
export type * from "./types";
