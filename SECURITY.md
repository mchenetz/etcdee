# Security Policy

## Supported Versions

etcdee has not yet reached a 1.0 release. Security fixes are made against
the `main` branch and released in the next version; there is no long-term
support branch yet.

| Version | Supported |
| --- | --- |
| latest (`main`) | :white_check_mark: |
| older tags | :x: |

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Report vulnerabilities privately using
[GitHub's private vulnerability reporting](https://github.com/mchenetz/etcdee/security/advisories/new)
for this repository. This creates a private advisory visible only to you and
the maintainers, and lets us collaborate on a fix before public disclosure.

If you are unable to use GitHub's private reporting, open an issue asking a
maintainer to contact you, without describing the vulnerability itself, and
a maintainer will follow up through a private channel.

Please include, where possible:

- A description of the vulnerability and its potential impact
- Steps to reproduce, or a proof of concept
- The version or commit of etcdee affected
- Any suggested mitigation

### What to expect

- **Acknowledgement**: within 5 business days of the report.
- **Initial assessment**: within 10 business days, including whether the
  report is accepted, needs more information, or is declined.
- **Disclosure**: coordinated with the reporter. We ask for 90 days before
  any public disclosure to allow time for a fix and release, and will credit
  the reporter in the advisory unless they ask otherwise.

## Scope

In scope: etcdee's Electron application code (`main.js`, `preload.js`,
`lib/`, `renderer/`), the in-cluster agent (`agent/`), and how they handle
etcd credentials, Kubernetes credentials, and cluster data.

Out of scope: vulnerabilities in etcd itself, Kubernetes, Electron, or other
upstream dependencies — please report those to the respective upstream
project. If you believe an upstream vulnerability is exploitable specifically
through etcdee's use of it, please do let us know.

## Notable design considerations for reviewers

- etcd and Kubernetes credentials (TLS certificates, passwords, kubeconfig
  paths) are handled in the Electron main process; the renderer is sandboxed
  with context isolation and no direct Node or network access — see
  [README.md § Architecture](README.md#architecture).
- Saved connection profile passwords are encrypted with the OS keychain via
  Electron's `safeStorage` when available.
- The in-cluster agent (`agent/agent.js`) is an authenticated TCP proxy
  scoped to an explicit allowed-ports list and a bearer token stored in a
  Kubernetes Secret; see [README.md § In-cluster agent mode](README.md#in-cluster-agent-mode).
