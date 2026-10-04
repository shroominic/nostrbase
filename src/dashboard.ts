import type { EventStore } from "applesauce-core";
import type { RelayPool } from "applesauce-relay";
import type { DiagnosticEntry, NostrbaseDiagnostics } from "./diagnostics";
import { asError, NostrbaseError } from "./errors";
import { decodeRecord, isObject, RECORD_KIND, verify } from "./protocol";
import type { Row, TableDefinition } from "./types";

export interface DashboardSnapshot {
  namespace: string;
  generatedAt: number;
  tables: {
    name: string;
    private: boolean;
    count: number;
    authors: string[];
    rows: Row<object>[];
  }[];
  relays: { url: string; connected: boolean; authenticated: boolean; pendingRequests: number }[];
  logs: DiagnosticEntry[];
  pendingWrites: { eventId: string; pubkey: string; kind: number }[];
}
interface DashboardHost {
  namespace: string;
  relays: string[];
  pool: RelayPool;
  eventStore: EventStore;
  diagnostics: NostrbaseDiagnostics;
  offline: { list(): Promise<{ event: { id: string; pubkey: string; kind: number } }[]> };
  definition<T extends object>(table: string): TableDefinition<T> | undefined;
  isDeleted(event: Parameters<EventStore["add"]>[0]): boolean;
  ready(): Promise<void>;
  assertOpen(): void;
  trackEventSubscription(dispose: () => void): () => void;
}
const escapeHtml = (text: string): string =>
  text.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ] as string,
  );

/** Read-only local inspector. Private plaintext is never decrypted or displayed. */
export class NostrbaseDashboard {
  constructor(private host: DashboardHost) {}
  async snapshot(): Promise<DashboardSnapshot> {
    await this.host.ready();
    this.host.assertOpen();
    const tables = new Map<string, DashboardSnapshot["tables"][number]>();
    const prefix = `nostrbase:${encodeURIComponent(this.host.namespace)}:`;
    for (const event of this.host.eventStore.getByFilters({ kinds: [RECORD_KIND] })) {
      if (!verify(event) || this.host.isDeleted(event)) continue;
      const tag = event.tags.find((entry) => entry[0] === "t" && entry[1]?.startsWith(prefix))?.[1];
      if (!tag) continue;
      let table: string;
      try {
        table = decodeURIComponent(tag.slice(prefix.length));
      } catch {
        continue;
      }
      const encrypted = event.tags.some((entry) => entry[0] === "encryption");
      if (!encrypted && table.startsWith("private:")) continue;
      if (!encrypted) {
        try {
          const envelope: unknown = JSON.parse(event.content);
          if (!isObject(envelope) || envelope.table !== table) continue;
        } catch {
          continue;
        }
      }
      const entry = tables.get(tag) ?? {
        name: encrypted && table.startsWith("private:") ? table.slice(8) : table,
        private: encrypted,
        count: 0,
        authors: [],
        rows: [],
      };
      if (!entry.authors.includes(event.pubkey)) entry.authors.push(event.pubkey);
      if (encrypted) entry.count++;
      else {
        const row = decodeRecord(event, this.host.namespace, table, this.host.definition(table));
        if (row) {
          entry.count++;
          entry.rows.push(row);
        }
      }
      tables.set(tag, entry);
    }
    const queue = await this.host.offline.list();
    return {
      namespace: this.host.namespace,
      generatedAt: Date.now(),
      tables: [...tables.values()],
      relays: this.host.relays.map((url) => {
        const relay = this.host.pool.relays.get(url);
        return {
          url,
          connected: relay?.connected ?? false,
          authenticated: relay?.authenticated ?? false,
          pendingRequests: Object.keys(relay?.reqs ?? {}).length,
        };
      }),
      logs: this.host.diagnostics.list(),
      pendingWrites: queue.map(({ event }) => ({
        eventId: event.id,
        pubkey: event.pubkey,
        kind: event.kind,
      })),
    };
  }
  async render(): Promise<string> {
    const snapshot = await this.snapshot();
    const json = JSON.stringify(snapshot).replace(/</g, "\\u003c");
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>nostrbase inspector</title><style>body{font:15px system-ui;background:#101923;color:#e8eff6;max-width:1100px;margin:auto;padding:32px}button{background:#24415e;color:white;border:1px solid #5781a5;border-radius:6px;padding:10px;margin:4px;cursor:pointer}button[aria-selected=true]{background:#426d91}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#182736;padding:20px;border-radius:8px}small{color:#acc1d1}</style></head><body><h1>nostrbase · ${escapeHtml(snapshot.namespace)}</h1><p>Local cache inspector. This snapshot does not establish complete relay data.</p><small>Private records show metadata only.</small><nav aria-label="Inspector sections" role="tablist">${["tables", "relays", "pendingWrites", "logs"].map((key) => `<button type="button" role="tab" data-section="${key}" aria-selected="${key === "tables"}">${key === "pendingWrites" ? "Pending writes" : key}</button>`).join("")}</nav><pre id="panel" role="tabpanel" aria-live="polite"></pre><script type="application/json" id="data">${json}</script><script>const data=JSON.parse(document.getElementById('data').textContent);const panel=document.getElementById('panel');function show(key){panel.textContent=JSON.stringify(data[key],null,2);document.querySelectorAll('button[data-section]').forEach(button=>button.setAttribute('aria-selected',String(button.dataset.section===key)));}document.querySelectorAll('button[data-section]').forEach(button=>button.addEventListener('click',()=>show(button.dataset.section)));show('tables');</script></body></html>`;
  }
  mount(
    element: HTMLElement,
    options: { interval?: number; onError?: (error: NostrbaseError) => void } = {},
  ): { refresh(): Promise<void>; destroy(): void } {
    this.host.assertOpen();
    const interval = options.interval ?? 2000;
    if (!Number.isSafeInteger(interval) || interval < 100)
      throw new NostrbaseError(
        "INVALID_CONFIG",
        "Dashboard refresh interval must be at least 100 ms.",
      );
    let destroyed = false;
    const heading = document.createElement("h2");
    heading.textContent = `nostrbase · ${this.host.namespace}`;
    const caption = document.createElement("p");
    caption.textContent = "Local verified cache. Private records show metadata only.";
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Refresh";
    const panel = document.createElement("pre");
    panel.setAttribute("aria-live", "polite");
    element.replaceChildren(heading, caption, button, panel);
    const refresh = async () => {
      try {
        const snapshot = await this.snapshot();
        if (!destroyed) panel.textContent = JSON.stringify(snapshot, null, 2);
      } catch (error) {
        if (!destroyed) {
          const converted = asError(error);
          panel.textContent = converted.message;
          try {
            options.onError?.(converted);
          } catch {
            /* Isolate observer. */
          }
        }
      }
    };
    const clicked = () => {
      void refresh();
    };
    button.addEventListener("click", clicked);
    const timer = setInterval(clicked, interval);
    void refresh();
    const destroy = () => {
      if (destroyed) return;
      destroyed = true;
      clearInterval(timer);
      button.removeEventListener("click", clicked);
      element.replaceChildren();
      untrack();
    };
    const untrack = this.host.trackEventSubscription(destroy);
    return { refresh, destroy };
  }
}
