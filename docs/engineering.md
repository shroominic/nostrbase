# Engineering baseline

## Scope and acceptance

This baseline maintains the existing TypeScript SDK, documentation site, and Fieldwork example. Keep Applesauce, npm, Biome, TypeScript, Vitest, and Playwright. The primary app flow remains signer connection, signed record access, realtime updates, offline recovery, and Blossom file access.

Acceptance: reproducible installs; passing SDK and documentation checks; source and staged secret checks; stable CI gates; a usable local hook; a recorded Git base; ownership, release, and dependency policies. This change has tooling and documentation risk. It does not change the SDK API, wire format, encryption, relay policy, or runtime behavior.

## Capability inventory

| Capability | Existing | Missing or conflicting | Baseline change |
| --- | --- | --- | --- |
| Runtime and installs | Node 22.12.0 pin, npm 11.16.0, four npm locks | Tool download/check policy | Checksum-pinned quality tools; preserve existing locks |
| Format, lint, types | Biome and strict TypeScript | No competing source tools | Preserve them; staged checks use index bytes |
| Tests | 224 fast tests; real service, browser, extension, and app projects | Fast CI could accept focused tests | Explicit CI rejection and zero retries |
| Commands | SDK, integration, app, and docs scripts | No named E2E/CI/security contract | Add aliases and checks through npm |
| Hooks | Optional whole-tree hook | Not enabled; staged content not checked | Enable local staged format/lint/secret checks and working-tree types |
| CI | SDK, integration, app workflows | Unpinned actions in older workflows; docs absent | Commit-pin all actions; add docs gate and scheduled reports |
| Supply chain | Locked installs and immutable integration inputs | No update automation or secret gate | Dependabot, redacted Gitleaks, audit reporting |
| Ownership and review | Contributor rules | No component map or review template | MAINTAINERS and pull-request template |
| Releases | Changelog, package tests, wire v1 policy | No operational release checklist | Document versioning, provenance, approval, and recovery |
| Git | Unborn `main`, all project source untracked | No clean source commit or remote | Record initial local baseline; preserve `main` |

The site uses Prettier as a library to render generated API snippets. It is not a second source formatter. Generated documentation/output and dependency lockfiles have intentional tooling exclusions; the site compiler/link checker and locked installs verify those boundaries.

## Reproducible commands

```sh
npm ci
npm ci --prefix site
npm run prepare:quality
npm run check-ci
```

`check` remains the fast SDK gate. `check-ci` runs `check`, the full documentation build/link check, source secret scanning, workflow validation, `test-baseline`, and `test-mutations`. The six baseline checks exercise the actual Git hook and scanner in disposable repositories: hidden staged format errors, valid partial staging, hidden staged keys with redaction, untracked secret detection, deletion-only type failures, and source symlinks that must not expose external files. `test-e2e` runs the existing packaged Fieldwork app checks. `test-extended` runs the existing local environment projects after `prepare:integrations`. Release candidates also run the applicable extended/app checks.

Quality tools are Gitleaks 8.30.1 and actionlint 1.7.12. Their release archives have committed SHA-256 pins for Linux/macOS arm64/x64. Preparation extracts only the named executable. It rechecks cached archives. Downloads and reports are under ignored `output/`. Windows SDK consumers remain supported by the published runtime contract; this repository's POSIX hooks/crash projects and quality bootstrap are verified on Linux/macOS only.

The pre-commit hook checks the staged snapshot without rewriting files or the index. TypeScript checks the working tree, so CI remains authoritative for committed types. Enable hooks with `git config core.hooksPath .githooks` after quality-tool preparation. No npm lifecycle script changes Git configuration automatically.

## Git and worktree policy

Keep `main` as the integration/control branch. No additional long-lived `feature/stable` branch is needed for this repository. `/Users/fungus/dev/nostrbase` is the control checkout. Start future work from a recorded clean `main` commit on `feature/<scope>`, `fix/<scope>`, `docs/<scope>`, or `chore/<scope>` in an isolated worktree. Use managed Codex worktrees or the sibling `_worktrees/nostrbase/<branch>` layout. Merge reviewed, verified commits back to `main`.

The initial bootstrap had no source commit, so a linked worktree could not contain its untracked source. The project owner authorized this setup in the existing checkout on 4 October 2026. This bootstrap exception expires at the initial baseline commit. It does not permit future work on a dirty control checkout. Do not stash, reset, clean, force-push, or change remotes as baseline maintenance.

## CI and external controls

The required SDK job remains named `check`, with Node 22.12.0 and the current Node 24 compatibility channel. Browser/service and Fieldwork jobs remain separate because they need their own preparation. Scheduled integration runs use the same bounded local services. Public endpoint writes are never part of automatic CI.

Every workflow uses read-only repository permissions and commit-pinned actions. Checkout credentials are not persisted. No production secret, publishing token, or protected deployment environment is configured. Reports retain seven days of synthetic test evidence; they can include development identities. Private live-cleanup keys are outside uploaded paths.

Before hosting, the repository owner must nominate maintainers, add real CODEOWNERS entries, protect `main`, require appropriate successful checks and independent review, enable private vulnerability reporting, and inspect the first hosted runs. Before publication, assign the npm destination and release approver. Local files do not prove these controls are enforced.

## Dependency changes

Dependabot proposes weekly updates for the SDK, site, extension build, and action pins. Review runtime compatibility, license impact, generated lock changes, and upstream integration versions before merge. The extension fixture's dependency/source pins are intentional: an update must still build its pinned upstream source. Fieldwork's SDK tarball lock is generated by `example:setup`; root tooling updates must also regenerate and verify its lock.

`audit:dependencies` reports all four lockfiles. Findings require maintainer triage; no severity gate is invented before an owner agrees on remediation policy. Network/report failures remain failures. Do not run an automatic `npm audit fix --force`.

## Controls register

The [contributor controls register](../CONTRIBUTING.md#controls-register) records owners, evidence, status, and external limits. [Ownership](../MAINTAINERS.md), [security](../SECURITY.md), [release policy](releasing.md), and [verification](verification.md) give the detailed rules and results.
