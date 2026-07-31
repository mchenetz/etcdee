# Changelog

All notable changes to this project are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project intends to follow [Semantic Versioning](https://semver.org/) once it
reaches 1.0.

## [Unreleased]

### Added

- Key browser with a hierarchical tree view, full CRUD, historical reads,
  and guarded prefix deletes.
- Read-only value views — pretty-printed JSON, Kubernetes protobuf
  decoding, gzip decompression, base64 decoding, inline images, and a hex
  dump — plus inline base64 encode/decode.
- Live watch, lease management, cluster status, and role-based access
  control (users, roles, permissions).
- Maintenance operations: snapshots, compaction, and defragmentation.
- Three connection modes: direct (multi-endpoint, TLS, auth), Kubernetes
  port-forward with etcd pod/service discovery, and an in-cluster broker
  agent for reaching any etcd address the cluster can route to, including
  every member of a multi-member cluster.
- A tool to fetch etcd client certificates directly from a cluster's API.

[Unreleased]: https://github.com/mchenetz/etcdee/commits/main
