# Governance

etcdee follows a lightweight governance model appropriate for its current
size, structured so it can grow into the model CNCF projects use as the
contributor base grows. It is not currently a CNCF project — this document
describes the project's own governance, written in that style so the
project is ready to align if it ever seeks CNCF hosting.

## Roles

**Maintainers** have merge access to the repository. They review and merge
pull requests, triage issues, cut releases, and are listed in
[MAINTAINERS.md](MAINTAINERS.md). Maintainers are expected to follow the
[Code of Conduct](CODE_OF_CONDUCT.md) and to enforce it fairly.

**Contributors** are anyone who submits an issue, pull request, or review
comment. No special access is required to contribute — see
[CONTRIBUTING.md](CONTRIBUTING.md).

## Decision making

Day-to-day engineering decisions (code review, small features, bug fixes)
are made by maintainer consensus on the pull request itself. Where
maintainers disagree, discussion continues on the issue or PR until
consensus is reached; with a single maintainer today, that maintainer makes
the final call, informed by contributor and user feedback in the issue
tracker.

As the maintainer group grows, decisions that affect the project as a whole
— governance changes, adding or removing a maintainer, adopting a new
license or CoC — require lazy consensus among maintainers: a proposal is
posted as a pull request or issue, and it is adopted if no maintainer
objects within 5 business days. An objection from any maintainer requires
discussion and a resolution before merging.

## Becoming a maintainer

Contributors who have made multiple substantive contributions (code,
review, documentation, or issue triage) over a sustained period may be
nominated for maintainer status by an existing maintainer, opened as a pull
request against [MAINTAINERS.md](MAINTAINERS.md). The nomination is adopted
under the lazy-consensus rule above.

## Removing a maintainer

A maintainer may step down at any time by opening a pull request removing
themselves from [MAINTAINERS.md](MAINTAINERS.md). A maintainer who is
inactive for an extended period, or whose conduct violates the
[Code of Conduct](CODE_OF_CONDUCT.md), may be removed by lazy consensus of
the remaining maintainers.

## Changes to this document

Changes to this governance document follow the same lazy-consensus process
described above.
