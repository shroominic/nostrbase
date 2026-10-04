# Security policy

## Supported versions

Nostrbase is an unpublished 0.2.0 SDK. Security fixes apply to the current development version. A supported release list and a private reporting contact must be set before the first publication. No support deadline or response service level is promised yet.

## Report a vulnerability

Contact the project owner privately through an agreed channel. This local repository has no public issue tracker or security mailbox. Before hosting on GitHub, enable private vulnerability reporting and publish its link here. Do not put an exploit, private key, personal data, or live account token in a public issue.

Include the affected version, a minimal reproduction with development keys, expected and actual behavior, and the likely impact. The owner records triage, an assigned maintainer, verification, and the release decision. Coordinate public disclosure after a fix is available.

## Repository checks

`npm run prepare:quality` installs checksum-pinned Gitleaks and actionlint. `npm run check-secrets` scans Git-tracked and non-ignored project files. `npm run check-secrets -- --staged` scans the index snapshot; `--history` scans all local Git history. Findings are fully redacted. Ignored output, development caches, and dependency directories are not source-scan inputs; they still require normal access controls.

The scanner uses upstream rules plus literal Nostr private-key and NIP-19 `nsec` rules. Source symlinks are scanned as link-target text; the scanner does not follow them into external files. Generated runtime identities are not source secrets. A scanner cannot establish that a repository is free of every secret. A suppression must identify a known development fixture or false positive, its reason, owner, and review date; do not ignore whole test directories.

`npm run audit:dependencies` reports the four locked npm projects. Vulnerability findings are visible reports until the owner agrees on remediation policy. Audit service errors fail the command. Runtime/API compatibility must be checked before dependency updates are accepted.

If a live credential is committed, revoke or rotate it first. Record the incident and assess downstream copies. Rewriting Git history does not revoke credentials. Public Nostr data and relay deletion requests cannot guarantee erasure from every copy.
