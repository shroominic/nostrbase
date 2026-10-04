import * as nostrTools from "nostr-tools";
import * as nostrbase from "../../../src";
import * as protocol from "../../../src/protocol";

/** Browser tests run the actual SDK and browser APIs; there are no persistence substitutes. */
declare global {
  interface Window {
    nostrbase: typeof nostrbase;
    nostrTools: typeof nostrTools;
    protocol: typeof protocol;
    harnessReady: boolean;
    clients: Map<string, nostrbase.NostrbaseClient>;
    adapters: Map<string, nostrbase.IndexedDBPersistenceAdapter>;
    pendingRead?: Promise<nostrbase.Result<nostrbase.Row<Record<string, unknown>>[]>>;
    readController?: AbortController;
    createHarnessClient: (options: {
      name: string;
      database: string;
      namespace: string;
      relay: string;
      seed?: number;
    }) => Promise<void>;
  }
}
window.nostrbase = nostrbase;
window.nostrTools = nostrTools;
window.protocol = protocol;
window.clients = new Map();
window.adapters = new Map();
window.createHarnessClient = async ({ name, database, namespace, relay, seed = 1 }) => {
  const adapter = new nostrbase.IndexedDBPersistenceAdapter(database);
  window.adapters.set(name, adapter);
  const client = nostrbase.createClient({
    namespace,
    relays: [relay],
    signer: new nostrbase.PrivateKeySigner(new Uint8Array(32).fill(seed)),
    persistence: { adapter, flushInterval: 60000 },
    timeout: 10000,
    relayOptions: { keepAlive: 0 },
  });
  window.clients.set(name, client);
  await client.ready();
};
window.harnessReady = true;
document
  .querySelector("#status")
  ?.replaceChildren("SDK loaded. Browser integration harness ready.");
