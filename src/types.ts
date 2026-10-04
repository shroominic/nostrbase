import type { EventStore } from "applesauce-core";
import type { RelayOptions, RelayPool } from "applesauce-relay";
import type { ISigner } from "applesauce-signers";
import type { EventTemplate, Filter, NostrEvent } from "nostr-tools";
import type { Observable } from "rxjs";
import type { DiagnosticsOptions } from "./diagnostics";
import type { NostrbaseError } from "./errors";
import type { OfflineOptions } from "./offline";
import type { PersistenceOptions } from "./persistence";
import type { StorageOptions } from "./storage";
import type { SyncOptions } from "./sync";

export type DatabaseSchema = Record<string, object>;
export type SchemaShape<DB> = { [K in keyof DB]: object };
export type DefaultSchema = Record<string, Record<string, unknown>>;
export interface RecordMetadata {
  pubkey: string;
  eventId: string;
  createdAt: number;
  updatedAt: number;
}
export type Row<T extends object> = T & { id: string; _nostr: RecordMetadata };
export type Insert<T extends object> = T & { id?: string };
export interface RelayResult {
  url: string;
  ok: boolean;
  message?: string;
}
export interface WriteReceipt {
  id: string;
  eventId: string;
  relays: RelayResult[];
  queued?: boolean;
}
export interface ResultMeta {
  relays: RelayResult[];
  partial: boolean;
  receipts?: WriteReceipt[];
  nextCursor?: string;
  cached?: boolean;
  queued?: boolean;
}
export interface Result<T> {
  data: T | null;
  error: NostrbaseError | null;
  count?: number;
  meta?: ResultMeta;
}
export interface TableDefinition<T extends object> {
  indexes?: readonly (keyof T & string)[];
  validate?: (data: unknown) => data is T;
}
export interface TransportRead {
  events: NostrEvent[];
  relays: RelayResult[];
}
/** Implement this interface to use a custom transport. Incoming events are verified by the SDK. */
export interface Transport {
  request(
    relays: string[],
    filters: Filter[],
    options: { timeout: number; signal: AbortSignal },
  ): Promise<TransportRead>;
  publish(
    relays: string[],
    event: NostrEvent,
    options: { timeout: number; signal: AbortSignal },
  ): Promise<RelayResult[]>;
  subscribe(relays: string[], filters: Filter[]): Observable<NostrEvent>;
}
export interface ClientOptions<DB extends SchemaShape<DB>> {
  /** A stable application namespace. It is part of every record address. */
  namespace: string;
  relays: readonly string[];
  signer?: ISigner;
  schema?: { [K in keyof DB]: TableDefinition<DB[K]> };
  timeout?: number;
  /** Minimum relay acknowledgements required for a successful write (default: 1). */
  minWriteAcks?: number;
  pool?: RelayPool;
  eventStore?: EventStore;
  relayOptions?: RelayOptions;
  transport?: Transport;
  persistence?: PersistenceOptions;
  offline?: OfflineOptions;
  sync?: SyncOptions;
  storage?: StorageOptions;
  diagnostics?: DiagnosticsOptions;
}
export interface User {
  id: string;
  pubkey: string;
}
export interface Session {
  user: User;
}
export type AuthChange = "INITIAL_SESSION" | "SIGNED_IN" | "SIGNED_OUT";
export type ChangeEvent = "INSERT" | "UPDATE" | "DELETE";
export interface ChangePayload<T extends object> {
  eventType: ChangeEvent;
  table: string;
  new: Row<T> | null;
  old: Row<T> | null;
  event: NostrEvent;
}
export interface ChangeFilter {
  table: string;
  event?: ChangeEvent | "*";
  author?: string /** Supabase-style equality: "done=eq.false". */;
  filter?: string;
}
export type ChannelStatus = "SUBSCRIBED" | "CHANNEL_ERROR" | "CLOSED";
export type Signer = ISigner;
export type { EventTemplate, Filter, NostrEvent };

type Trim<S extends string> = S extends ` ${infer R}`
  ? Trim<R>
  : S extends `${infer R} `
    ? Trim<R>
    : S;
type Columns<S extends string> = S extends `${infer L},${infer R}` ? Trim<L> | Columns<R> : Trim<S>;
export type Selection<T, C extends string> = string extends C
  ? C
  : C extends "*"
    ? C
    : Exclude<Columns<C>, keyof T> extends never
      ? C
      : never;
export type Projection<T, C extends string> = C extends "*"
  ? T
  : string extends C
    ? Partial<T>
    : Pick<T, Extract<Columns<C>, keyof T>>;
export type Cardinality = "many" | "one" | "maybe";
export type QueryData<T, C extends Cardinality> = C extends "many"
  ? T[]
  : C extends "one"
    ? T
    : T | null;
