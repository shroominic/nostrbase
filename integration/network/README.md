# Network fault integration

Run `npm run test-network-faults` after `node integration/relay/prepare.mjs` and `node integration/blossom/setup.mjs`. Docker and the pinned Blossom runtime/source must be available. A missing prerequisite fails the project.

The WebSocket proxy forwards to independent **strfry 1.1.3**. The HTTP proxy forwards to independent **hzrd149/blossom-server 6.4.0**. The proxies inject only the selected transport faults; upstream software decides acceptance, persistence, signature validation, and ownership.

| Contract | Fault boundary and required result |
| --- | --- |
| Uncertain queued write | Hold a real positive relay ACK, abort delivery, restart the upstream relay with SIGKILL, reopen the client, and replay exactly the same signed event. Require one stored event and remove the queue entry only after an ACK is released. |
| Cancelled read | Hold a real EVENT and EOSE, abort the SDK read, require wire CLOSE, then send the delayed frames. A later completed request proves the old frames were drained without cache ingestion. |
| Reconnect recovery | Cut established sockets and gate new upstream connections. Create and delete records during the cut. Release the gate and require recovered records, deletion tombstones, actual Negentropy requests, and continued live updates. |
| Interrupted download | Cut before headers or after one body byte. Require an error, no partial Blob, and a complete byte-identical retry. |
| Uncertain upload | Hold the successful upstream response before headers. Confirm the server stored the file, abort the client, and repeat the same content. Require the same hash and one owned object. |

Faults start after observed protocol or stream boundaries. No sleep schedules a fault. Deadline timers only fail when a required boundary is missing. The helpers own and close downstream sockets, upstream sockets, pending request streams, and waiters.

The queue adapter in this project is an explicit **memory storage fixture**, preserved across two SDK instances. This isolates the network delivery contract. It does not prove browser or filesystem queue durability; browser and crash-recovery projects check those storage boundaries. Relay disk recovery and all socket/HTTP traffic here are real.
