'use strict';

const fs = require('fs');
const { Etcd3 } = require('etcd3');
const { KubeBridge, AgentTunnel, discoverEndpoints } = require('./kube-bridge');
const agentManager = require('./agent-manager');

/**
 * etcd3 retries recoverable failures forever, so a bad port, a firewalled
 * host, or a plaintext dial to a TLS-only server never rejects — it just
 * hangs. Bound the initial probe so the UI always gets an answer.
 */
function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

const CONNECT_TIMEOUT_MS = 15000;
// One unreachable member must never stall the whole Cluster view.
const MEMBER_PROBE_TIMEOUT_MS = 6000;

function parseEndpoint(raw) {
  let s = String(raw).trim();
  if (!/^[a-z+]+:\/\//i.test(s)) s = `http://${s}`;
  const u = new URL(s);
  return { host: u.hostname, port: Number(u.port) || 2379, scheme: u.protocol.replace(':', '') };
}

/**
 * EtcdService owns the etcd3 client for the active connection plus any
 * live watchers. All methods return plain JSON-serializable objects so
 * results can cross the IPC boundary untouched.
 */
class EtcdService {
  constructor() {
    this.client = null;
    this.profile = null;
    this.watchers = new Map(); // watchId -> watcher
    this.kubeBridge = null;    // active kubectl-style port-forward, if any
    this.agentTunnel = null;   // active in-cluster agent tunnel, if any
  }

  // ---------------------------------------------------------------- helpers

  _buildOptions(profile) {
    const hosts = String(profile.endpoints || 'http://127.0.0.1:2379')
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean);

    const options = { hosts };

    if (profile.tls && (profile.caFile || profile.certFile || profile.keyFile)) {
      const credentials = {};
      if (profile.caFile) credentials.rootCertificate = fs.readFileSync(profile.caFile);
      if (profile.certFile) credentials.certChain = fs.readFileSync(profile.certFile);
      if (profile.keyFile) credentials.privateKey = fs.readFileSync(profile.keyFile);
      options.credentials = credentials;
    }

    if (profile.username) {
      options.auth = { username: profile.username, password: profile.password || '' };
    }

    // Fail fast instead of hanging forever on a bad endpoint.
    options.dialTimeout = 5000;

    // Dialing a TLS etcd through a local tunnel means connecting to
    // 127.0.0.1, but TLS ServerName may not be an IP. Present "localhost"
    // instead — kubeadm/kind etcd server certs always carry that SAN.
    if (profile.kube && profile.kube.enabled && profile.tls) {
      options.grpcOptions = {
        'grpc.ssl_target_name_override': 'localhost',
        'grpc.default_authority': 'localhost',
      };
    }
    return options;
  }

  _clientFor(endpoint) {
    // A short-lived client pinned to one endpoint, reusing the active
    // profile's TLS/auth settings. Used for per-member status queries.
    const profile = { ...this.profile, endpoints: endpoint };
    return new Etcd3(this._buildOptions(profile));
  }

  _requireClient() {
    if (!this.client) throw new Error('Not connected to etcd');
    return this.client;
  }

  static _decodeValue(buf) {
    if (!buf) return { text: '', encoding: 'utf8', size: 0 };
    const size = buf.length;
    const text = buf.toString('utf8');
    // Round-trip check: invalid UTF-8 decodes with U+FFFD replacement
    // characters, so re-encoding changes the byte length or leaves \uFFFD.
    const control = /[\u0000-\u0008\u000e-\u001f]/;
    const isBinary =
      Buffer.from(text, 'utf8').length !== size ||
      text.includes('\uFFFD') ||
      control.test(text);
    if (isBinary) {
      return { text: buf.toString('base64'), encoding: 'base64', size };
    }
    return { text, encoding: 'utf8', size };
  }

  static _statusOf(s, memberId) {
    return {
      version: s.version,
      dbSize: String(s.dbSize),
      dbSizeInUse: String(s.dbSizeInUse || 0),
      leader: String(s.leader),
      raftTerm: String(s.raftTerm),
      raftIndex: String(s.raftIndex),
      isLeader: String(s.leader) === String(memberId),
      errors: s.errors || [],
    };
  }

  static _kvMeta(kv) {
    return {
      key: kv.key.toString('utf8'),
      createRevision: String(kv.create_revision),
      modRevision: String(kv.mod_revision),
      version: String(kv.version),
      lease: String(kv.lease || '0'),
    };
  }

  // ------------------------------------------------------------- connection

  async connect(profile) {
    await this.disconnect();
    // Set once the agent proves it can reach a target, so a later timeout
    // can be attributed to the protocol rather than the address.
    let agentReached = null;

    if (profile.kube && profile.kube.enabled && profile.kube.mode === 'agent') {
      // Reach etcd through the in-cluster etcdee-agent: one port-forward to
      // the agent pod, then a local tunnel per etcd endpoint.
      const tunnel = new AgentTunnel();
      try {
        const kubeOpts = {
          configPath: profile.kube.configPath,
          context: profile.kube.context,
          namespace: profile.kube.agentNamespace || 'etcdee-agent',
        };
        const status = await agentManager.agentStatus(kubeOpts);
        if (!status.deployed || !status.ready) {
          throw new Error(status.deployed
            ? `etcdee-agent pod is not ready (${status.phase})`
            : 'etcdee-agent is not deployed in this cluster — use “Deploy agent” first');
        }
        const token = await agentManager.readToken(kubeOpts);
        await tunnel.start({ ...kubeOpts, pod: status.pod, agentPort: agentManager.AGENT_PORT, token });
        await tunnel.verify();

        let endpoints = String(profile.endpoints || '')
          .split(',').map((e) => e.trim()).filter(Boolean);
        if (endpoints.length === 0) {
          // No endpoints given: reach every etcd pod the cluster knows about.
          endpoints = await discoverEndpoints({
            configPath: profile.kube.configPath,
            context: profile.kube.context,
            namespace: profile.kube.searchNamespace || null,
            port: profile.kube.remotePort || 2379,
            tls: profile.tls,
          });
        }
        const localEndpoints = [];
        for (const raw of endpoints) {
          const { host, port } = parseEndpoint(raw);
          if (['127.0.0.1', 'localhost', '::1'].includes(host)) {
            throw new Error(
              `“${raw}” points at the agent pod itself. In agent mode endpoints must be ` +
              'addresses the cluster can route to — leave the field blank to auto-discover ' +
              'every etcd pod, or use a service DNS name or pod IP.');
          }
          // Ask the agent first: a refusal here is precise, whereas letting
          // the etcd client discover it would surface as a connect timeout.
          const status = await tunnel.probe(host, port);
          if (status === 403) {
            throw new Error(
              `The in-cluster agent will not connect to port ${port}. Its allowed-ports list ` +
              'is set when the agent is deployed — press “Deploy / update agent” to redeploy ' +
              `it with port ${port} included, then connect again.`);
          }
          if (status === 407) {
            throw new Error('The agent rejected our token. Redeploy the agent to reissue it.');
          }
          if (status !== 200) {
            throw new Error(
              `The agent could not open a connection to ${host}:${port}` +
              (status ? ` (HTTP ${status})` : '') +
              '. Check the address and that etcd is listening on that port inside the cluster.');
          }
          agentReached = agentReached || `${host}:${port}`;
          const { localPort } = await tunnel.openTunnel(host, port);
          localEndpoints.push(`${profile.tls ? 'https' : 'http'}://127.0.0.1:${localPort}`);
        }
        profile = { ...profile, endpoints: localEndpoints.join(',') };
        this.agentTunnel = tunnel;
      } catch (err) {
        await tunnel.stop();
        throw err;
      }
    } else if (profile.kube && profile.kube.enabled) {
      // Tunnel to the pod through the Kubernetes API, then dial the local
      // end of the tunnel. TLS (if configured) is etcd's own client TLS,
      // carried inside the tunnel.
      const bridge = new KubeBridge();
      try {
        const { localPort } = await bridge.start(profile.kube);
        const scheme = profile.tls ? 'https' : 'http';
        profile = { ...profile, endpoints: `${scheme}://127.0.0.1:${localPort}` };
        this.kubeBridge = bridge;
      } catch (err) {
        await bridge.stop();
        throw err;
      }
    }

    let client;
    try {
      client = new Etcd3(this._buildOptions(profile));
    } catch (err) {
      await this._stopBridge();
      throw err;
    }
    // Prove the connection works before accepting it.
    let status;
    try {
      status = await withTimeout(
        client.maintenance.status(),
        CONNECT_TIMEOUT_MS,
        this._timeoutHint(profile, agentReached),
      );
    } catch (err) {
      try { client.close(); } catch (_) { /* ignore */ }
      await this._stopBridge();
      throw err;
    }
    this.client = client;
    this.profile = profile;
    return {
      version: status.version,
      dbSize: String(status.dbSize),
      leader: String(status.leader),
      raftTerm: String(status.raftTerm),
      memberId: status.header ? String(status.header.member_id) : '',
      clusterId: status.header ? String(status.header.cluster_id) : '',
      revision: status.header ? String(status.header.revision) : '',
    };
  }

  async disconnect() {
    for (const [id, watcher] of this.watchers) {
      try { await watcher.cancel(); } catch (_) { /* already gone */ }
      this.watchers.delete(id);
    }
    if (this.client) {
      try { this.client.close(); } catch (_) { /* ignore */ }
    }
    this.client = null;
    this.profile = null;
    await this._stopBridge();
  }

  _timeoutHint(profile, reached) {
    const base = `No response from etcd after ${CONNECT_TIMEOUT_MS / 1000}s`;
    // In agent mode we already proved the TCP connection succeeds, so the
    // address and port are right and only the protocol can be wrong.
    if (reached) {
      return `${base}, even though the agent opened a TCP connection to ${reached} — ` +
        'so the address and port are correct and this is a protocol mismatch. ' +
        (profile.tls
          ? 'These certificates are probably not the ones this etcd uses; an application\'s ' +
            'etcd (Portworx kvdb, a Helm chart, an operator) does not accept the control-plane ' +
            'certificates. If it serves plaintext, untick “Use TLS client certificates”.'
          : 'This etcd is probably TLS-only — tick “Use TLS client certificates” and supply its CA, ' +
            'client certificate, and key.');
    }
    if (!profile.tls) {
      return `${base}. Most clusters (OpenShift, kubeadm, kind) require TLS — ` +
        'tick “Use TLS client certificates” and supply etcd\'s CA, client cert, and key. ' +
        'A plaintext connection to a TLS-only etcd hangs exactly like this.';
    }
    return `${base}. Check that the endpoint really is etcd's client port ` +
      '(2379 by default — set “etcd port” if this cluster differs) and that the CA, ' +
      'certificate, and key belong to this cluster.';
  }

  async _stopBridge() {
    if (this.kubeBridge) {
      try { await this.kubeBridge.stop(); } catch (_) { /* ignore */ }
      this.kubeBridge = null;
    }
    if (this.agentTunnel) {
      try { await this.agentTunnel.stop(); } catch (_) { /* ignore */ }
      this.agentTunnel = null;
    }
  }

  // --------------------------------------------------------------------- kv

  async listKeys({ prefix = '', limit = 5000 } = {}) {
    const { Range } = require('etcd3');
    const client = this._requireClient();
    const req = { limit: String(limit), keys_only: true };
    if (prefix) {
      const range = Range.prefix(prefix);
      req.key = range.start;
      req.range_end = range.end;
    } else {
      req.key = Buffer.from([0]);
      req.range_end = Buffer.from([0]);
    }
    const res = await client.kv.range(req);
    return {
      keys: (res.kvs || []).map((kv) => EtcdService._kvMeta(kv)),
      more: Boolean(res.more),
      count: String(res.count || (res.kvs || []).length),
      revision: res.header ? String(res.header.revision) : '',
    };
  }

  async getKey({ key, revision = null } = {}) {
    const client = this._requireClient();
    let builder = client.get(key);
    if (revision) builder = builder.revision(revision);
    const res = await builder.exec();
    if (!res.kvs || res.kvs.length === 0) return { found: false, key };
    const kv = res.kvs[0];
    return {
      found: true,
      ...EtcdService._kvMeta(kv),
      value: EtcdService._decodeValue(kv.value),
    };
  }

  async putKey({ key, value, encoding = 'utf8', leaseId = null } = {}) {
    const client = this._requireClient();
    const buf = encoding === 'base64' ? Buffer.from(value, 'base64') : Buffer.from(value, 'utf8');
    let builder = client.put(key).value(buf);
    if (leaseId && leaseId !== '0') builder = builder.lease(leaseId);
    const res = await builder.exec();
    return { ok: true, revision: res.header ? String(res.header.revision) : '' };
  }

  async deleteKey({ key } = {}) {
    const client = this._requireClient();
    const res = await client.delete().key(key).exec();
    return { deleted: String(res.deleted) };
  }

  async deletePrefix({ prefix } = {}) {
    if (!prefix) throw new Error('Refusing to delete with an empty prefix');
    const client = this._requireClient();
    const res = await client.delete().prefix(prefix).exec();
    return { deleted: String(res.deleted) };
  }

  // ------------------------------------------------------------------ watch

  async startWatch({ id, target, isPrefix }, onEvent) {
    const client = this._requireClient();
    let builder = client.watch();
    builder = isPrefix ? builder.prefix(target) : builder.key(target);
    const watcher = await builder.withPreviousKV().create();

    watcher.on('put', (kv, previous) => {
      onEvent({
        watchId: id,
        type: 'put',
        key: kv.key.toString('utf8'),
        value: EtcdService._decodeValue(kv.value),
        modRevision: String(kv.mod_revision),
        version: String(kv.version),
        prevValue: previous ? EtcdService._decodeValue(previous.value) : null,
        at: Date.now(),
      });
    });
    watcher.on('delete', (kv, previous) => {
      onEvent({
        watchId: id,
        type: 'delete',
        key: kv.key.toString('utf8'),
        modRevision: String(kv.mod_revision),
        prevValue: previous ? EtcdService._decodeValue(previous.value) : null,
        at: Date.now(),
      });
    });
    watcher.on('error', (err) => {
      onEvent({ watchId: id, type: 'error', message: err.message, at: Date.now() });
    });

    this.watchers.set(id, watcher);
    return { ok: true };
  }

  async stopWatch({ id } = {}) {
    const watcher = this.watchers.get(id);
    if (watcher) {
      await watcher.cancel();
      this.watchers.delete(id);
    }
    return { ok: true };
  }

  // ----------------------------------------------------------------- leases

  async grantLease({ ttl } = {}) {
    const client = this._requireClient();
    const res = await client.leaseClient.leaseGrant({ TTL: String(ttl) });
    return { id: String(res.ID), ttl: String(res.TTL) };
  }

  async listLeases() {
    const client = this._requireClient();
    const res = await client.leaseClient.leaseLeases({});
    const leases = [];
    for (const l of res.leases || []) {
      const id = String(l.ID);
      try {
        const ttlRes = await client.leaseClient.leaseTimeToLive({ ID: id, keys: true });
        leases.push({
          id,
          ttl: String(ttlRes.TTL),
          grantedTtl: String(ttlRes.grantedTTL),
          keys: (ttlRes.keys || []).map((k) => k.toString('utf8')),
        });
      } catch (err) {
        leases.push({ id, ttl: '?', grantedTtl: '?', keys: [], error: err.message });
      }
    }
    return { leases };
  }

  async revokeLease({ id } = {}) {
    const client = this._requireClient();
    await client.leaseClient.leaseRevoke({ ID: id });
    return { ok: true };
  }

  // ---------------------------------------------------------------- cluster

  async clusterOverview() {
    const client = this._requireClient();
    const memberRes = await client.cluster.memberList({});

    // When tunnelling, the member we are connected to can always be reported
    // from our own connection — no second dial needed.
    let selfStatus = null;
    if (this.kubeBridge || this.agentTunnel) {
      try { selfStatus = await client.maintenance.status(); } catch (_) { /* ignore */ }
    }
    const isSelf = (m) => Boolean(selfStatus?.header &&
      String(selfStatus.header.member_id) === String(m.ID));

    const members = [];
    for (const m of memberRes.members || []) {
      const member = {
        id: String(m.ID),
        name: m.name || '(unnamed)',
        peerURLs: m.peerURLs || [],
        clientURLs: m.clientURLs || [],
        isLearner: Boolean(m.isLearner),
        status: null,
        statusError: null,
      };
      if (isSelf(m)) {
        member.status = EtcdService._statusOf(selfStatus, m.ID);
        members.push(member);
        continue;
      }

      if (this.agentTunnel) {
        // The agent reaches in-cluster addresses, but a member advertising a
        // loopback client URL (common for single-node and dev etcd) would
        // resolve to the agent pod itself.
        const endpoint = (m.clientURLs || [])[0];
        if (!endpoint) { members.push(member); continue; }
        const { host, port } = parseEndpoint(endpoint);
        if (['127.0.0.1', 'localhost', '::1'].includes(host)) {
          member.statusError = `advertises a loopback client URL (${endpoint}), which the agent cannot reach`;
          members.push(member);
          continue;
        }
        // Ask the agent first: members often advertise addresses only they
        // can resolve (Portworx kvdb uses *.internal.kvdb), and this reports
        // that in milliseconds instead of waiting out the probe timeout.
        const reach = await this.agentTunnel.probe(host, port);
        if (reach !== 200) {
          member.statusError = reach === 403
            ? `the agent is not allowed to reach port ${port} — redeploy it with that port`
            : `the agent cannot reach ${host}:${port}${reach ? ` (HTTP ${reach})` : ''}`;
          members.push(member);
          continue;
        }
        let probe = null;
        try {
          const { localPort } = await this.agentTunnel.openTunnel(host, port);
          const scheme = this.profile.tls ? 'https' : 'http';
          probe = this._clientFor(`${scheme}://127.0.0.1:${localPort}`);
          member.status = EtcdService._statusOf(
            await withTimeout(probe.maintenance.status(), MEMBER_PROBE_TIMEOUT_MS,
              `no response within ${MEMBER_PROBE_TIMEOUT_MS / 1000}s`),
            m.ID);
        } catch (err) {
          member.statusError = err.message;
        } finally {
          if (probe) { try { probe.close(); } catch (_) { /* ignore */ } }
        }
        members.push(member);
        continue;
      }

      if (this.kubeBridge) {
        member.statusError = 'not reachable through the port-forward (in-cluster address)';
        members.push(member);
        continue;
      }

      const endpoint = (m.clientURLs || [])[0];
      if (endpoint) {
        let probe = null;
        try {
          probe = this._clientFor(endpoint);
          member.status = EtcdService._statusOf(
            await withTimeout(probe.maintenance.status(), MEMBER_PROBE_TIMEOUT_MS,
              `no response within ${MEMBER_PROBE_TIMEOUT_MS / 1000}s`),
            m.ID);
        } catch (err) {
          member.statusError = err.message;
        } finally {
          if (probe) { try { probe.close(); } catch (_) { /* ignore */ } }
        }
      }
      members.push(member);
    }
    return { members };
  }

  async listAlarms() {
    const client = this._requireClient();
    const res = await client.maintenance.alarm({ action: 'GET', memberID: '0', alarm: 'NONE' });
    return {
      alarms: (res.alarms || []).map((a) => ({
        memberId: String(a.memberID),
        alarm: String(a.alarm),
      })),
    };
  }

  async disarmAlarm({ memberId, alarm } = {}) {
    const client = this._requireClient();
    await client.maintenance.alarm({ action: 'DEACTIVATE', memberID: memberId, alarm });
    return { ok: true };
  }

  async moveLeader({ targetId } = {}) {
    const client = this._requireClient();
    await client.maintenance.moveLeader({ targetID: targetId });
    return { ok: true };
  }

  // ------------------------------------------------------------ maintenance

  async status() {
    const client = this._requireClient();
    const s = await client.maintenance.status();
    return {
      version: s.version,
      dbSize: String(s.dbSize),
      dbSizeInUse: String(s.dbSizeInUse || 0),
      leader: String(s.leader),
      raftTerm: String(s.raftTerm),
      raftIndex: String(s.raftIndex),
      revision: s.header ? String(s.header.revision) : '',
      memberId: s.header ? String(s.header.member_id) : '',
      errors: s.errors || [],
    };
  }

  async defragment() {
    const client = this._requireClient();
    await client.maintenance.defragment({});
    return { ok: true };
  }

  async compact({ revision } = {}) {
    const client = this._requireClient();
    let rev = revision;
    if (!rev) {
      const s = await client.maintenance.status();
      rev = s.header ? String(s.header.revision) : null;
    }
    if (!rev) throw new Error('Could not determine revision to compact to');
    await client.kv.compact({ revision: rev, physical: true });
    return { ok: true, revision: String(rev) };
  }

  async snapshot({ filePath }, onProgress) {
    const client = this._requireClient();
    const stream = await client.maintenance.snapshot();
    return new Promise((resolve, reject) => {
      const out = fs.createWriteStream(filePath);
      let written = 0;
      stream.on('data', (chunk) => {
        const blob = chunk.blob || chunk;
        if (blob && blob.length) {
          written += blob.length;
          out.write(blob);
          if (onProgress) onProgress({ written });
        }
      });
      stream.on('end', () => {
        out.end(() => resolve({ ok: true, path: filePath, bytes: written }));
      });
      stream.on('error', (err) => {
        out.destroy();
        fs.unlink(filePath, () => reject(err));
      });
    });
  }

  // ------------------------------------------------------------------- auth

  async authOverview() {
    const client = this._requireClient();
    const [users, roles] = await Promise.all([
      client.getUsers().catch(() => []),
      client.getRoles().catch(() => []),
    ]);
    const userList = [];
    for (const u of users) {
      let roleNames = [];
      try {
        const r = await u.roles();
        roleNames = r.map((role) => role.name);
      } catch (_) { /* auth may be disabled */ }
      userList.push({ name: u.name, roles: roleNames });
    }
    const roleList = [];
    for (const r of roles) {
      let permissions = [];
      try {
        const perms = await r.permissions();
        permissions = perms.map((p) => ({
          permission: p.permission,
          key: p.range && p.range.start ? p.range.start.toString('utf8') : '',
          rangeEnd: p.range && p.range.end ? p.range.end.toString('utf8') : '',
        }));
      } catch (_) { /* ignore */ }
      roleList.push({ name: r.name, permissions });
    }
    let enabled = null;
    try {
      const st = await client.auth.authStatus({});
      enabled = Boolean(st.enabled);
    } catch (_) { /* older etcd: unknown */ }
    return { users: userList, roles: roleList, enabled };
  }

  async userAdd({ name, password } = {}) {
    const client = this._requireClient();
    await client.user(name).create(password);
    return { ok: true };
  }

  async userDelete({ name } = {}) {
    const client = this._requireClient();
    await client.user(name).delete();
    return { ok: true };
  }

  async userGrantRole({ name, role } = {}) {
    const client = this._requireClient();
    await client.user(name).addRole(role);
    return { ok: true };
  }

  async userRevokeRole({ name, role } = {}) {
    const client = this._requireClient();
    await client.user(name).removeRole(role);
    return { ok: true };
  }

  async roleAdd({ name } = {}) {
    const client = this._requireClient();
    await client.role(name).create();
    return { ok: true };
  }

  async roleDelete({ name } = {}) {
    const client = this._requireClient();
    await client.role(name).delete();
    return { ok: true };
  }

  async roleGrantPermission({ name, permission, key, prefix } = {}) {
    const { Range } = require('etcd3');
    const client = this._requireClient();
    const range = prefix ? Range.prefix(key) : new Range(key);
    await client.role(name).grant({ permission, range });
    return { ok: true };
  }

  async roleRevokePermission({ name, key, prefix } = {}) {
    const { Range } = require('etcd3');
    const client = this._requireClient();
    const range = prefix ? Range.prefix(key) : new Range(key);
    await client.role(name).revoke({ permission: 'Readwrite', range });
    return { ok: true };
  }
}

module.exports = { EtcdService };
