import type { Observable } from "rxjs";
import { Subject } from "rxjs";
import { NostrbaseError } from "./errors";

export type DiagnosticType =
  | "request"
  | "publish"
  | "ingest"
  | "error"
  | "connection"
  | "sync"
  | "queue";
export interface DiagnosticEntry {
  sequence: number;
  timestamp: number;
  type: DiagnosticType;
  operation: string;
  details: Readonly<Record<string, string | number | boolean | null>>;
}
export interface DiagnosticsOptions {
  enabled?: boolean;
  capacity?: number;
  onEntry?: (entry: DiagnosticEntry) => void;
}
/** Content, keys, signer objects, headers, and payloads are never included in SDK diagnostics. */
export class NostrbaseDiagnostics {
  private entries: DiagnosticEntry[] = [];
  private sequence = 0;
  private subject = new Subject<DiagnosticEntry>();
  readonly events$: Observable<DiagnosticEntry> = this.subject.asObservable();
  private capacity: number;
  constructor(private options: DiagnosticsOptions = {}) {
    this.capacity = options.capacity ?? 200;
    if (!Number.isSafeInteger(this.capacity) || this.capacity < 1 || this.capacity > 10000)
      throw new NostrbaseError(
        "INVALID_CONFIG",
        "Diagnostic capacity must be between 1 and 10000.",
      );
  }
  record(
    type: DiagnosticType,
    operation: string,
    details: Record<string, string | number | boolean | null> = {},
  ): void {
    if (this.options.enabled === false || this.subject.closed) return;
    const entry = Object.freeze({
      sequence: ++this.sequence,
      timestamp: Date.now(),
      type,
      operation,
      details: Object.freeze({ ...details }),
    });
    this.entries.push(entry);
    if (this.entries.length > this.capacity) this.entries.shift();
    this.subject.next(entry);
    try {
      this.options.onEntry?.(entry);
    } catch {
      /* Isolate log observers. */
    }
  }
  list(): DiagnosticEntry[] {
    return [...this.entries];
  }
  clear(): void {
    this.entries = [];
  }
  close(): void {
    this.subject.complete();
  }
}
