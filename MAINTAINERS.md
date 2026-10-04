# Ownership and review

The project owner is accountable for this repository. No GitHub account, npm organization, or security contact has been assigned. Assign named people before hosting or publication; then add CODEOWNERS with those real accounts. This role map is local policy, not enforced GitHub approval.

| Area | Responsible role | Review focus |
| --- | --- | --- |
| `src/`, protocol, public declarations | SDK maintainer | API compatibility, signed data, ownership, encryption, partial receipts |
| `tests/`, `integration/`, test setup | SDK maintainer | Independent evidence, deterministic faults, cleanup, pinned software |
| `site/`, `docs/`, examples | Documentation maintainer | Working examples, links, accessibility, accurate feature claims |
| `.github/`, `.githooks/`, `scripts/`, lockfiles | Repository maintainer | Least privilege, reproducibility, supply chain, local/CI parity |
| Security reports and release approval | Project owner | Private handling, risk decisions, publication authority |

One person can fill several roles. A substantive change needs an independent reviewer before merge. Authentication, author checks, private data, protocol changes, and releases need review by someone who can assess that risk. Routine documentation changes need one relevant reviewer; no fixed reviewer count or coverage target applies.

Record the scope, acceptance criteria, risk, checks run, and remaining limits in the pull request or local review record. CI does not replace review. Review requirements remain unenforced until the hosted repository has branch rules.
