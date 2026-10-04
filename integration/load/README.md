# Bounded load integration

Prepare pinned relay images with `node integration/relay/prepare.mjs`, then run:

```sh
npm run test-load
```

The project uses independent **strfry 1.1.3** over real loopback WebSockets. A missing Docker/image prerequisite fails the project.

## Workload and limits

| Setting | Default | Allowed range |
| --- | --- | --- |
| `NOSTRBASE_LOAD_DURATION_MS` | 20,000 ms | 1,000–120,000 ms |
| `NOSTRBASE_LOAD_ROWS` | 64 records | 64–128 records |

The sustained test has three warmup cycles, followed by actual work for the selected duration. Each cycle creates two channels, waits for upstream EOSE, delivers one signed broadcast, joins and leaves Presence, removes both channels, and drains each connection through another request. It requires exact notification counts, no cached ephemeral events, zero remaining requests, removed channel timers, and bounded diagnostics. The timer hook records direct `NostrbaseChannel` interval calls; each cycle must create the two expiry intervals and one sender heartbeat, so the cleanup check cannot pass without observing timers. Idle connections also have Applesauce/RxJS liveness timers. Client close must close every observed WebSocket and return Node's referenced platform timer resources to their initial baseline. A 10,000-cycle guard and operation deadlines prevent runaway work. The per-test timeout expands with the selected duration.

The batch test queues the selected number of distinct records, repeats insertion at the start/middle/end of the queue, closes and reopens the SDK, drains the queue, republishes all the same signatures, and verifies exact upstream event identities. Only the SDK's wall-clock Date is fixed during this batch; sockets, timer deadlines, performance timing, and the independent server remain real. A timestamp group must exceed the 31-row page size. Cursor pages must return every record once. A combined field/tag query must return the known subset. The selected limit stays below this pinned relay's 500-event query cap. The batch has a 120-second deadline.

Queue storage is an explicit **memory adapter fixture**. These checks isolate load and network contracts. Browser and crash projects check durable storage.

## Metrics

Reports under `output/environment/load/*.json` include pinned relay image/version, Node version, cycles, message counts, latency summaries, resource counts, and GC-assisted heap/RSS snapshots. The realtime workload runs in its own `node --expose-gc` child; Vitest and fixture memory do not affect those snapshots. esbuild builds that child from the current SDK source and uses the installed dependencies.

Latency and memory are measured, without machine-dependent pass thresholds. Pass/fail checks use explicit ownership and lifecycle contracts. Persistent distinct record history can grow by design; no cache eviction guarantee is asserted. This is a bounded local workload, not a production capacity result or a days-long soak test.

Queue insertion currently verifies earlier queue entries repeatedly. Cryptographic work grows with the square of a batch's size. The conservative default makes this cost visible in metrics while keeping local runs practical; this project does not establish efficient behavior for thousands of queued records.

## Local reference run

On Node 26.3.0, the default run completed 52 sustained cycles in 20.18 seconds, plus three warmup cycles. It delivered 55 broadcasts, 55 Presence joins, and 55 leaves. All 165 signed writes were acknowledged. All 222 requests had matching CLOSE messages, diagnostics reached their 32-entry capacity, and final owned sockets, subscriptions, channel intervals, referenced platform timers, and cached events were zero.

The 64-record batch completed in 11.16 seconds and returned three cursor pages. All 64 records shared a timestamp, all exact event identities survived replay, and no queued entries or pending requests remained. These are measured local results, not required performance scores or a capacity guarantee. The JSON reports retain the heap/RSS snapshots and latency summaries.
