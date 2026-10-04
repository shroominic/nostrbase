# Marmot engine snapshot

This project bundles `@internet-privacy/marmot-ts` 0.6.0 from source. That version was not available as a current npm release when this integration was made. The older npm 0.5.x engine uses a deprecated Marmot protocol revision.

| Source | Pinned commit |
| --- | --- |
| [marmot-ts](https://github.com/marmot-protocol/marmot-ts) | `591eb25f6ba0b69cb6dc7b711fb75836da7ddbaa` |
| Engine MLS fork submodule | `af6d1c599f2912fda5fbcac1b461fdd3013e37c7` |
| Marmot specification submodule | `26fa6a6972d7b4325cb3d105ffdd41a1ceda2bb0` |

Archive: `internet-privacy-marmot-ts-0.6.0-nostrbase.2.tgz`.

SHA-256: `32517f50ced5ea88964d38be6f03e2001550ff1948fbcead8d585fa16a14f0e0`.

The archive contains the upstream compiled engine, its vendored MLS fork, package metadata, and MIT license. `bundledDependencies` includes the engine and its runtime dependencies in the SDK package. This avoids a downstream dependency on a local source path. Optional crypto suites are not used by this integration.

## Rebuild

```sh
git clone https://github.com/marmot-protocol/marmot-ts.git
cd marmot-ts
git checkout 591eb25f6ba0b69cb6dc7b711fb75836da7ddbaa
git submodule update --init
git apply /absolute/path/to/vendor/patches/marmot-ingress-durability.patch
git apply /absolute/path/to/vendor/patches/marmot-convergence-timer.patch
pnpm install --frozen-lockfile
pnpm build
npm pack --ignore-scripts
```

The upstream build compiles the pinned MLS submodule, then rewrites engine imports to the vendored fork. Do not replace that fork with the registry `ts-mls` package. Compare extracted archive contents when rebuilding; archive metadata can alter the archive checksum.

This snapshot is experimental. Upstream states that it is not ready for production. No independent cryptographic audit or released White Noise interoperability check is claimed. The dependency can increase the browser bundle; ordinary public table APIs keep their existing behavior.

## SDK ingress patch

The recorded patch adds an awaited `beforeIngestResult` session hook before consumed receiving ratchets and terminal wrapper receipts are saved. The SDK uses it to persist authenticated pending record outcomes under self encryption. It also covers convergence and history replay. It does not change cryptographic primitives, ciphertext, or protocol rules. A hook failure requires disposal and reload of the mutated session.

Patch SHA-256: `8ee446c1dca79c278ddbd7f680d7d6f69f9b8fa7e6a50ecce9bf8245a293ade2`.

## Convergence timer patch

The timer patch rounds fractional delays up and schedules another check if the host timer runs before the monotonic convergence cutoff. Without this correction, an early check can leave a send in the queue with no further timer, even after convergence becomes settled. The owner callback runs only at or after the real cutoff. The patch preserves the engine's `Settled` and `Stable` checks and does not change cryptographic or protocol rules.

Patch SHA-256: `1c2c27e9cd468e723970b1f26794d585f7dcb006909426486108e1aee4be80e2`.
