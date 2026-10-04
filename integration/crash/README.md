# Abrupt crash recovery integration project

```sh
npx playwright install chromium
npm run test-crash-recovery
```

The project requires macOS or Linux and an installed Playwright Chromium binary.
Missing prerequisites cause a clear failure. Windows cannot provide the POSIX
process-group SIGKILL used here and fails explicitly.

The parent test process keeps a local HTTP origin and WebSocket relay fixture
alive. Each test starts a separate Chromium process group with a temporary,
persistent browser profile. Playwright connects through CDP. Recovery opens a
new Chromium process with the same profile and origin, so IndexedDB bytes come
from the previous process.

The tests send **SIGKILL to the group they created**, including Chromium helper
processes. They verify the browser exited from SIGKILL and that no live process
remains in that group. No SDK, page, context, or browser shutdown occurs before
the crash. CDP disconnects after process death. Temporary profiles are removed
at test cleanup; browser logs remain under `output/environment/crash/`.

Four tests cover separate failure windows:

1. Committed public and encrypted private queue entries survive abrupt death.
   Replay sends the same event IDs, timestamps, signatures, tags, and ciphertext.
2. A real relay accepts an event and replies with OK. A gate pauses the SDK at
   the call to durable queue removal. SIGKILL leaves the committed attempt count
   and queue event on disk. Recovery replays exactly the same event, the relay
   fixture deduplicates it, and the queue drains.
3. Committed deletion events survive death. Hydration does not restore the older
   cached record that the tombstone removes.
4. The SDK's real IndexedDB queue write has executed, but its transaction is
   still active. Real IDB requests keep the transaction open. SIGKILL aborts it.
   Recovery finds no queue entry, cached optimistic row, or persisted event.

The gates only control scheduling. They do not simulate process death, replace
IndexedDB, inject storage errors, or change signed data. The ACK gate pauses
before removal starts; the transaction gate checks rollback before commit.

These tests verify abrupt process termination, including browser storage-service
termination. They do not simulate machine power loss, damaged disks, OS cache
loss, mobile operating-system eviction, or abrupt Firefox/WebKit death. Relay
software compatibility is tested in the separate relay-service project.
