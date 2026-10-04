# Contributing

## Setup and commands

Use Node 22.12+ and npm 11.16.0. The package is ESM. TypeScript 5.9.3 is pinned because the declaration build does not support TypeScript 7.

```sh
npm ci
npm ci --prefix site
npm run prepare:quality
npm run check
```

| Command | Purpose |
| --- | --- |
| `npm run format` | Format with Biome |
| `npm run format-check` | Check formatting |
| `npm run lint` | Run Biome lint rules |
| `npm run typecheck` | Check source, tests, and examples |
| `npm run test-unit` | Unit and component contracts, types, async races, and durable failure cases |
| `npm run test-integration` | Local WebSocket/HTTP, restart recovery, shared resources, and packed SDK consumer |
| `npm run test-e2e` | Existing packaged Fieldwork application checks in three browsers |
| `npm run test-baseline` | Actual staged-hook and secret-scanner contracts in disposable Git repositories |
| `npm run test-mutations` | Check that eight named tests detect deliberate behavioral faults in a temporary copy |
| `npm test` | Run the fast unit and integration projects |
| `npm run prepare:integrations` | Prepare pinned services, browser engines, and the extension |
| `npm run test-extended` | Run all local environment projects after preparation |
| `npm run test-live-services` | Run compatibility checks against explicitly configured endpoints |
| `npm run build` | Build ESM, source maps, and declarations |
| `npm run check` | Run the fast SDK gates |
| `npm run check-ci` | SDK gate, documentation, secrets, workflows, baseline contracts, and mutation checks |
| `npm run prepare:quality` | Install checksum-pinned Gitleaks and actionlint |
| `npm run check-secrets` | Scan project source with fully redacted findings |
| `npm run check-staged` | Check index formatting, lint, secrets, and working-tree types |
| `npm run check-workflows` | Validate workflow syntax with pinned actionlint |
| `npm run audit:dependencies` | Report advisories for all four npm locks without an invented severity gate |
| `npm pack` | Run checks and build a distributable archive |
| `npm audit` | Report dependency advisories |
| `npm run docs:dev` | Build the SDK and serve documentation locally |
| `npm run docs:build` | Check and build static documentation; verify links and API coverage |
| `npm run docs:preview` | Preview the documentation build |

Install documentation dependencies with `npm ci --prefix site`. See [docs/README.md](docs/README.md) for content sources and authoring.

Local tests use development identities and loopback services. See [environment projects](integration/README.md) for Docker, browser, Deno, and extension setup. Live checks connect only to explicitly configured endpoints and require separate opt-in for writes. For a downstream application, install the built tarball and import `nostrbase`.

See [testing](docs/testing.md) for the contract map, fixture rules, fault checks, commands, and environment limits. Add a test only when it protects a stated contract or a specific regression. Do not add tests to meet a line coverage percentage. Async tests must control their race boundary and release resources when an assertion fails.

## Change and release rules

Keep the public API, record protocol, examples, and tests in the same change. Test author checks, signer failures, version ties, deletes, partial publications, and resource cleanup when their paths change. Update the changelog for public changes.

Run `npm run check` before review and `npm run check-ci` before merge. The pre-commit hook checks staged formatting, lint, and secrets without rewriting the index, then checks working-tree types. Enable it with `git config core.hooksPath .githooks` after `prepare:quality`. The hook is enabled in the current local repository; each fresh checkout must opt in. npm installation does not change Git configuration.

Keep `/Users/fungus/dev/nostrbase` on clean `main` as the control checkout. Future implementation work uses an isolated worktree from a recorded clean commit. No upstream remote or registry publishing is configured. Get independent review before substantive merges and releases. See the [engineering baseline](docs/engineering.md), [ownership map](MAINTAINERS.md), [security policy](SECURITY.md), and [release policy](docs/releasing.md).

The project owner selects maintainers, a registry name, and the release destination before publication. No person or organization is assumed to own release approval.

## Controls register

| Control | Applies | Status | Evidence | Owner | Exception expiry |
| --- | --- | --- | --- | --- | --- |
| Reproducible dependencies | SDK and tooling | Configured | package-lock.json, pinned dev tools | Project maintainer | — |
| Format, lint, types, tests, build | Each change | Local gates | npm run check | Contributor | — |
| Relay integration | Transport changes | Automated | Local WebSocket tests | Contributor | — |
| Signature and author checks | Writes and reads | Automated | SDK and regression tests | Project maintainer | — |
| API/wire compatibility | Public releases | Documented | Protocol v1, type tests, changelog | Release maintainer | — |
| Fast commit hook | Local contributors | Locally enabled; opt-in per checkout | .githooks/pre-commit | Contributor | — |
| Staged content checks | Local commits | Configured and locally enabled | check-staged, core.hooksPath | Contributor | — |
| Source/history secrets | Commits and CI | Configured | Gitleaks pins, .gitleaks.toml, security.yml | Repository maintainer | — |
| Workflow and docs validity | Pull requests | Local gates | check-ci, actionlint, site compiler/link checker | Repository maintainer | — |
| Dependency advisories/updates | Four npm projects and actions | Reporting/configured | audit:dependencies, Dependabot | Repository maintainer | — |
| Ownership and change review | Substantive changes | Documented | MAINTAINERS.md, PR template | Project owner | Named accounts before hosting |
| Release traceability/recovery | Publication | Documented | docs/releasing.md | Release owner | — |
| Isolated bootstrap worktree | Initial source commit | Bootstrap exception | No base commit existed at task start | Project owner | Initial baseline commit |
| GitHub checks | Hosted repository | Unverified external | .github/workflows/check.yml | Repository owner | — |
| Independent release review | Public release | Pending | No release has been made | Repository owner | Before publication |
| Protected branches and npm access | Hosted repository and registry | Unverified external | No remote/registry setup | Repository owner | — |

The pre-release source is version 0.2.0. CI files describe intended checks; local evidence does not prove hosted enforcement. See [verification](docs/verification.md) for local results. Named GitHub/npm maintainers, branch protections, private vulnerability reporting, publication access, and hosted CI remain external setup work for the project owner.
