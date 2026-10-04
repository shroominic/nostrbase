# Changelog

## Unreleased

- Complete local engineering controls: staged hooks, secret/workflow checks, dependency reporting and updates, documentation CI, action pins, ownership, and release policy.

- Add Fieldwork, a complete browser example consuming the packed SDK, with a project board, personal notes, files, live room, offline replay, and developer tools.
- Add application browser tests across Chromium, Firefox, and WebKit against independent nak relay/Blossom services, NIP-77 fallback, and a separate NIP-46 signer process.
- Add application setup, a local service runner, a separate CI workflow, and a developer experience report.

- Add separate integration projects for independent relays and Blossom, real browser IndexedDB, NIP-46 providers, NIP-07 extension permissions, network faults, abrupt browser crashes, and bounded load.
- Add pinned environment preparation, explicit opt-in deployment compatibility checks, and separate CI jobs with failure artifacts.

- Add a static documentation site with guides, generated TypeScript reference, local search, responsive navigation, light/dark themes, and Markdown exports.
- Validate documentation examples, exported API coverage, local links, and search anchors during the site build.

- Expand unit and integration tests for protocol validation, query semantics, signer races, durable commit failures, reconciliation, callbacks, migrations, and backups.
- Add real HTTP Blossom tests, shared-pool and private WebSocket tests, a restart workflow, and an automated packed-package TypeScript/ESM/browser consumer check.
- Add separate Vitest projects and eight deliberate-fault checks in a disposable copy.
- Honor cancellation on public cache reads; snapshot signed native publications and ingested cache events.
- Isolate public/private change payloads and native events from observers; suppress stale deletion changes when the shared cache has a newer surviving version.

## 0.2.0

- Add signed ephemeral Broadcast and Presence with per-session heartbeats and expiry.
- Add personal NIP-44 encrypted tables, including CRUD, cached reads, queued writes, and private changes.
- Add Blossom upload, download, list, and deletion with scoped signed auth and SHA-256 checks.
- Add IndexedDB and memory persistence, durable signed write queues, and explicit exact-event replay.
- Add NIP-77 Negentropy pull recovery with ordinary query fallback and opt-in startup/reconnect recovery.
- Add local table text search, NIP-50 raw event search, and newest-first cursor pagination.
- Add Zod schema inference, author-scoped references, and validated client data migrations with dry runs.
- Add local signed-event backups, a read-only cache dashboard, and bounded content-free diagnostics.
- Add async close for durable cleanup; reserve the `private:` table prefix for encrypted routing.
- Reject signature verification cache bypasses and account changes during signing. Preserve deletion history in backups and persistence. Resolve latest candidate versions before cursor selection.
- Emit local queued record changes, including deletes, without duplicate relay echoes.

## 0.1.0

- Add a Supabase-style client built on Applesauce 6.
- Add typed table reads, insert, upsert, update, delete, filters, projection, and cardinality.
- Add signer auth with NIP-07, private keys, and custom Applesauce signers.
- Add record change channels, including a postgres_changes alias.
- Add native Nostr event queries, publishing, and subscriptions.
- Add NIP-78 record encoding, NIP-09 deletion handling, signature checks, ownership checks, and write receipts.
- Add cancellation, relay timeouts, resource cleanup, examples, and local WebSocket integration tests.
