# Release and compatibility policy

Nostrbase is local and unpublished. There is no configured npm publisher, release automation, or registry destination. The project owner must choose those before publication.

## Compatibility

During 0.x, patch releases preserve documented public API and wire contracts. A minor release may introduce API changes with release notes and a migration guide. After 1.0, use SemVer: breaking public API changes require a major release. Deprecations need a replacement, documentation, and a stated removal version before removal.

Record wire version `v: 1` is separate from the npm package version. Do not reinterpret existing signed data. Wire changes need a new version or explicit migration with old/new read behavior, ownership checks, rehearsal, and recovery evidence. Unknown wire versions stay unreadable under the documented protocol.

## Prepare and verify

1. Assign a release owner and independent reviewer. Confirm the npm package name, destination, and authority.
2. Use a clean reviewed Git commit. Update package versions, the SDK lock metadata, and changelog. Regenerate Fieldwork's packed dependency through `example:setup`; do not hand-edit its artifact hash.
3. Restore frozen SDK and site dependencies. Prepare quality tools and integration inputs. Run `check-ci`, `test-mutations`, `test-extended`, `test-e2e`, and the NIP-77 fallback app check. Record runtime versions, exact commands, and results.
4. Run `audit:dependencies`; triage findings and any time-bounded exceptions. Review package contents, MIT notices, dependency licenses, and secret-check results. Test-service/extension licenses do not automatically become the SDK's license.
5. Run `npm pack` into a dedicated artifact folder. It executes the existing prepack SDK gate. Record the source commit, Node/npm versions, archive SHA-256, and package file list. Keep the archive that was verified; do not silently rebuild a different publication artifact.
6. Verify the archive in a separate consumer. Existing package tests check ESM exports, declarations, private/offline CRUD, and browser bundling. Use a fresh registry dependency install when validating the actual public candidate; local linked dependencies alone do not prove registry installation.
7. Obtain explicit publication approval. Publish the verified archive only through the approved account. Prefer registry provenance/trusted publishing when the owner configures it; do not add publishing credentials to pull-request jobs.

## Recovery

If a release is defective, document the affected range, deprecate that version where the registry permits it, and issue a verified patch. Apps can pin the previous compatible package. Registry deletion is not the default recovery plan.

Wire migrations, relay publications, and blobs can outlive a package rollback. A signed deletion request does not guarantee global erasure. Preserve compatible readers and provide a migration or repair plan when data contracts change.

This SDK does not operate an application backend. Relay availability, retention, hosted app rollback, file-serving policy, and app observability belong to the app/deployment owner. Use the SDK's bounded diagnostics without publishing private records or keys.
