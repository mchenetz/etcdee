# Contributing to etcdee

Thanks for considering a contribution. This guide covers how to file issues,
submit changes, and what's expected of a pull request.

By participating in this project you agree to abide by the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Reporting bugs and requesting features

Search [existing issues](https://github.com/mchenetz/etcdee/issues) first.
For a bug, include etcdee's version, your OS, the etcd version, and — for
Kubernetes connection issues — the connection mode (direct, port-forward, or
agent). For security vulnerabilities, see [SECURITY.md](SECURITY.md) instead
of opening a public issue.

## Developer Certificate of Origin (DCO)

Every commit must be signed off, certifying that you wrote it or otherwise
have the right to submit it under the project's license, per the
[Developer Certificate of Origin](https://developercertificate.org/):

```
Developer Certificate of Origin
Version 1.1

Copyright (C) 2004, 2006 The Linux Foundation and its contributors.

Everyone is permitted to copy and distribute verbatim copies of this
license document, but changing it is not allowed.


Developer's Certificate of Origin 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am
    permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.
```

Add a `Signed-off-by` line to every commit with `git commit -s`:

```
Fix watch reconnect after the agent tunnel drops

Signed-off-by: Jane Doe <jane@example.com>
```

The name and email must match a commit author identity (`git config
user.name` / `user.email`). Forgot to sign off? Amend it:

```bash
git commit --amend -s
```

Pull requests are checked automatically and cannot be merged without every
commit signed off.

## Making changes

1. Fork the repository and create a branch from `main`.
2. Make your change, matching the existing code style (see below).
3. Run the test suites relevant to your change (see [Testing](#testing)).
4. Commit with a clear message and DCO sign-off (see above).
5. Open a pull request against `main` describing what changed and why.
   Link any related issue.

### Code style

- No build step: the renderer is plain HTML/CSS/JS, loaded directly by
  Electron — see [README.md § Architecture](README.md#architecture).
- Prefer small, focused commits and pull requests over large ones.
- Match the comment style already in the codebase: comments explain *why*,
  not *what* — see the repository's existing files for examples.
- New IPC calls follow the existing pattern in `main.js` / `preload.js`:
  every call returns `{ ok, data }` or `{ ok: false, error }`, and the
  renderer never talks to Node or the network directly.

### Testing

```bash
npm install
npm run smoke        # exercises EtcdService against a local etcd
npm run smoke:kube    # exercises the Kubernetes connection paths (see the
                      # header of test/kube-smoke.js for required env vars)
```

For UI changes, run `npm start` and exercise the affected view directly —
there is no automated UI test suite yet. If you add one, it's a welcome
contribution.

Both smoke suites need a reachable etcd; a disposable
[kind](https://kind.sigs.k8s.io) cluster is the easiest way to get one — see
[README.md § Try it on a local cluster](README.md#try-it-on-a-local-cluster).

### Pull request review

A maintainer will review your PR — see [MAINTAINERS.md](MAINTAINERS.md).
Expect feedback on scope, security implications (this project handles etcd
and Kubernetes credentials — see [SECURITY.md](SECURITY.md)), and test
coverage. CI must pass, including the DCO check, before merge.

## Where to start

Issues labeled `good first issue` (once triaged) are a reasonable starting
point. Documentation fixes, additional test coverage, and accessibility
improvements are always welcome even without an existing issue.
