'use strict';

const net = require('net');
const os = require('os');
const path = require('path');
const fs = require('fs');
// @kubernetes/client-node v1+ is ESM-only; load it lazily so this module
// stays require()-able from Electron's CommonJS main process.
let k8sPromise = null;
function k8sMod() {
  if (!k8sPromise) k8sPromise = import('@kubernetes/client-node');
  return k8sPromise;
}

const DEFAULT_KUBECONFIG = path.join(os.homedir(), '.kube', 'config');

async function loadConfig(configPath, context) {
  const k8s = await k8sMod();
  const file = configPath || DEFAULT_KUBECONFIG;
  if (!fs.existsSync(file)) throw new Error(`kubeconfig not found: ${file}`);
  const kc = new k8s.KubeConfig();
  kc.loadFromFile(file);
  if (context) {
    if (!kc.getContexts().some((c) => c.name === context)) {
      throw new Error(`context “${context}” not found in ${file}`);
    }
    kc.setCurrentContext(context);
  }
  return kc;
}

async function listContexts({ configPath } = {}) {
  const kc = await loadConfig(configPath);
  const current = kc.getCurrentContext();
  return {
    path: configPath || DEFAULT_KUBECONFIG,
    contexts: kc.getContexts().map((c) => ({
      name: c.name,
      cluster: c.cluster,
      namespace: c.namespace || '',
      current: c.name === current,
    })),
  };
}

function looksLikeEtcd(pod) {
  const labels = pod.metadata?.labels || {};
  if (
    labels.component === 'etcd' ||
    labels.app === 'etcd' ||
    labels.kvdb !== undefined ||
    (labels['app.kubernetes.io/name'] || '').includes('etcd')
  ) return true;
  // Portworx runs its internal etcd as "kvdb"; the pod is only a placeholder
  // (a pause image) marking the node, so the name is the only signal.
  if (/(^|-)kvdb(-|$)/.test(pod.metadata?.name || '')) return true;
  // Otherwise the strongest signal is a container actually named etcd or
  // running an etcd image. (Matching the pod name alone misfires when the
  // cluster name itself contains "etcd".)
  return (pod.spec?.containers || []).some((c) =>
    c.name === 'etcd' || /kvdb/.test(c.name) || /(^|\/)etcd(:|$|@)/.test(c.image || ''));
}

function podSummary(pod) {
  const ports = [];
  for (const c of pod.spec?.containers || []) {
    for (const p of c.ports || []) ports.push(p.containerPort);
  }
  return {
    namespace: pod.metadata.namespace,
    name: pod.metadata.name,
    phase: pod.status?.phase || 'Unknown',
    node: pod.spec?.nodeName || '',
    ip: pod.status?.podIP || '',
    hostNetwork: Boolean(pod.spec?.hostNetwork),
    ports,
  };
}

async function listNamespaces({ configPath, context } = {}) {
  const k8s = await k8sMod();
  const kc = await loadConfig(configPath, context);
  const core = kc.makeApiClient(k8s.CoreV1Api);
  try {
    const res = await core.listNamespace();
    return { namespaces: (res.items || []).map((n) => n.metadata.name).sort() };
  } catch (err) {
    // Listing namespaces cluster-wide is often forbidden even when the user
    // can work inside one; the caller lets them type a name instead.
    throw new Error(`Could not list namespaces (${err.body?.message || err.message}). ` +
      'You can still type the namespace by hand.');
  }
}

/**
 * Find candidate etcd pods.
 * @param namespace  restrict to one namespace; omit to scan the cluster
 * @param includeAll list every pod, not just ones that look like etcd —
 *                   needed for app-level etcd that follows no convention
 */
async function discoverPods({ configPath, context, namespace, includeAll = false } = {}) {
  const k8s = await k8sMod();
  const kc = await loadConfig(configPath, context);
  const core = kc.makeApiClient(k8s.CoreV1Api);

  const collect = (items) => {
    const pods = (items || []).map((p) => ({ ...podSummary(p), etcdLike: looksLikeEtcd(p) }));
    return includeAll ? pods : pods.filter((p) => p.etcdLike);
  };

  if (namespace) {
    let res;
    try {
      res = await core.listNamespacedPod({ namespace });
    } catch (err) {
      throw new Error(`Could not list pods in “${namespace}” (${err.body?.message || err.message}).`);
    }
    const pods = collect(res.items);
    if (pods.length === 0) {
      throw new Error((res.items || []).length === 0
        ? `No pods in namespace “${namespace}”.`
        : `No etcd-like pods in “${namespace}” — tick “list every pod” to choose one manually.`);
    }
    return { pods };
  }

  // Prefer a cluster-wide scan; fall back to likely namespaces when RBAC
  // forbids listing across all namespaces.
  try {
    const res = await core.listPodForAllNamespaces();
    return { pods: collect(res.items) };
  } catch (err) {
    const namespaces = new Set(['kube-system', 'default', 'etcd', 'openshift-etcd']);
    const ctxNs = kc.getContexts().find((c) => c.name === kc.getCurrentContext())?.namespace;
    if (ctxNs) namespaces.add(ctxNs);
    const pods = [];
    let lastErr = err;
    for (const ns of namespaces) {
      try {
        const res = await core.listNamespacedPod({ namespace: ns });
        pods.push(...collect(res.items));
      } catch (nsErr) { lastErr = nsErr; }
    }
    if (pods.length === 0) {
      throw new Error(`Could not list pods (${lastErr.body?.message || lastErr.message}). ` +
        'Choose a namespace explicitly, or check that the kubeconfig user may list pods.');
    }
    return { pods };
  }
}

const ETCD_PORT_NAMES = /^(etcd|client|etcd-client)$/i;
// Ports an etcd service exposes that are not the client port.
const NON_CLIENT_PORTS = /peer|metric|health|debug/i;

/**
 * Services fronting etcd. For an app-level etcd deployed by a chart or
 * operator, the service DNS name is a more stable endpoint than a pod IP.
 * @param port  the client port in use, when it is not the standard 2379
 */
async function discoverServices({ configPath, context, namespace, port = null } = {}) {
  const k8s = await k8sMod();
  const kc = await loadConfig(configPath, context);
  const core = kc.makeApiClient(k8s.CoreV1Api);

  const res = namespace
    ? await core.listNamespacedService({ namespace })
    : await core.listServiceForAllNamespaces();

  const services = [];
  for (const svc of res.items || []) {
    const name = svc.metadata.name;
    const ns = svc.metadata.namespace;
    const selectorish = name.includes('etcd') ||
      (svc.spec?.selector && Object.values(svc.spec.selector).some((v) => String(v).includes('etcd')));
    const wanted = port ? Number(port) : null;
    for (const p of svc.spec?.ports || []) {
      const named = ETCD_PORT_NAMES.test(p.name || '');
      const standard = p.port === 2379;
      const configured = wanted !== null && p.port === wanted;
      // An etcd-ish service may serve a non-standard client port, so accept
      // any of its ports except the ones that clearly are not for clients.
      const plausible = selectorish && !NON_CLIENT_PORTS.test(p.name || '');
      if (!(named || standard || configured || plausible)) continue;
      services.push({
        namespace: ns,
        name,
        port: p.port,
        // A service may publish a different port than the pods listen on
        // (Portworx kvdb: 9019 → 17016). Callers need this to know that a
        // pod IP on the service port would not answer.
        targetPort: p.targetPort === undefined ? p.port : p.targetPort,
        portName: p.name || '',
        headless: svc.spec?.clusterIP === 'None',
        dns: `${name}.${ns}.svc:${p.port}`,
      });
    }
  }
  return { services };
}

/**
 * A local TCP server whose every connection is tunnelled to one pod port
 * through the Kubernetes API server (same mechanism as `kubectl port-forward`).
 */
class KubeBridge {
  constructor() {
    this.server = null;
    this.sockets = new Set();
    this.target = null;
  }

  async start({ configPath, context, namespace, pod, remotePort = 2379 } = {}) {
    if (!namespace || !pod) throw new Error('Namespace and pod are required for port-forward');
    await this.stop();

    const k8s = await k8sMod();
    const kc = await loadConfig(configPath, context);
    const forward = new k8s.PortForward(kc);
    const port = Number(remotePort) || 2379;

    this.server = net.createServer((socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
      forward.portForward(namespace, pod, [port], socket, null, socket)
        .catch(() => socket.destroy());
    });

    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', resolve);
    });

    this.target = { namespace, pod, remotePort: port };
    return { localPort: this.server.address().port };
  }

  async stop() {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
      this.server = null;
    }
    this.target = null;
  }
}

/**
 * Multiplexed tunnels to arbitrary in-cluster addresses, brokered by the
 * etcdee-agent pod. One KubeBridge port-forward reaches the agent; each
 * target gets its own local listener whose connections do an authenticated
 * HTTP CONNECT handshake with the agent, then become raw pipes.
 */
class AgentTunnel {
  constructor() {
    this.bridge = new KubeBridge();
    this.agentLocalPort = null;
    this.token = null;
    this.servers = new Map(); // "host:port" -> net.Server
    this.sockets = new Set();
  }

  async start({ configPath, context, namespace, pod, agentPort = 8080, token }) {
    this.token = token;
    const { localPort } = await this.bridge.start({
      configPath, context, namespace, pod, remotePort: agentPort,
    });
    this.agentLocalPort = localPort;
  }

  /** Open (or reuse) a local listener tunnelled to host:port in-cluster. */
  async openTunnel(host, port) {
    const key = `${host}:${port}`;
    const existing = this.servers.get(key);
    if (existing) return { localPort: existing.address().port };

    const http = require('http');
    const server = net.createServer((local) => {
      this.sockets.add(local);
      local.on('close', () => this.sockets.delete(local));
      const req = http.request({
        host: '127.0.0.1',
        port: this.agentLocalPort,
        method: 'CONNECT',
        path: key,
        headers: { authorization: `Bearer ${this.token}` },
      });
      req.on('connect', (res, upstream, head) => {
        if (res.statusCode !== 200) { local.destroy(); upstream.destroy(); return; }
        this.sockets.add(upstream);
        upstream.on('close', () => this.sockets.delete(upstream));
        if (head && head.length) local.write(head);
        upstream.pipe(local);
        local.pipe(upstream);
        upstream.on('error', () => local.destroy());
        local.on('error', () => upstream.destroy());
      });
      req.on('error', () => local.destroy());
      req.end();
    });

    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    this.servers.set(key, server);
    return { localPort: server.address().port };
  }

  /**
   * Ask the agent to open one connection to host:port and report what
   * happened, without keeping the socket. Turns an agent refusal into an
   * immediate, specific error instead of a client-side connect timeout.
   * @returns {Promise<number>} HTTP status from the agent, or 0 if the agent
   *   accepted the request but could not reach the target.
   */
  async probe(host, port) {
    const http = require('http');
    return new Promise((resolve) => {
      const req = http.request({
        host: '127.0.0.1',
        port: this.agentLocalPort,
        method: 'CONNECT',
        path: `${host}:${port}`,
        headers: { authorization: `Bearer ${this.token}` },
        timeout: 10000,
      });
      // 2xx arrives as 'connect'; anything else as a normal response.
      req.on('connect', (res, socket) => { socket.destroy(); resolve(res.statusCode); });
      req.on('response', (res) => { res.resume(); resolve(res.statusCode); });
      req.on('timeout', () => { req.destroy(); resolve(0); });
      req.on('error', () => resolve(0));
      req.end();
    });
  }

  /** Ping the agent's /healthz through the tunnel to verify auth + reachability. */
  async verify() {
    const http = require('http');
    return new Promise((resolve, reject) => {
      const req = http.get(
        { host: '127.0.0.1', port: this.agentLocalPort, path: '/healthz', timeout: 8000 },
        (res) => { res.resume(); res.statusCode === 200 ? resolve() : reject(new Error(`agent healthz: HTTP ${res.statusCode}`)); });
      req.on('timeout', () => { req.destroy(new Error('agent healthz timed out')); });
      req.on('error', reject);
    });
  }

  async stop() {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    for (const server of this.servers.values()) {
      await new Promise((resolve) => server.close(resolve));
    }
    this.servers.clear();
    await this.bridge.stop();
    this.agentLocalPort = null;
  }
}

/**
 * Turn discovered etcd pods into in-cluster endpoint URLs, so agent mode
 * works without the user typing addresses by hand.
 */
async function discoverEndpoints({ configPath, context, namespace, port = 2379, tls = true } = {}) {
  const scheme = tls ? 'https' : 'http';

  let services = [];
  try {
    ({ services } = await discoverServices({ configPath, context, namespace, port }));
  } catch (_) { /* pods may still work */ }

  // When a service publishes a different port than the pods listen on, only
  // the service address is usable — a pod IP on the published port answers
  // nothing. (Portworx kvdb publishes 9019 but listens on 17016.)
  const remapped = services.filter((s) => String(s.targetPort) !== String(s.port));
  if (remapped.length) return remapped.map((s) => `${scheme}://${s.dns}`);

  // Otherwise prefer pod IPs: they address each member individually, which
  // is what the Cluster view needs.
  let pods = [];
  try {
    ({ pods } = await discoverPods({ configPath, context, namespace }));
  } catch (_) { /* fall through to services */ }
  const fromPods = pods
    .filter((p) => p.phase === 'Running' && p.ip)
    .map((p) => `${scheme}://${p.ip}:${port}`);
  if (fromPods.length) return fromPods;

  if (services.length) return services.map((s) => `${scheme}://${s.dns}`);

  throw new Error(
    namespace
      ? `No etcd pods or services found in “${namespace}” — enter the endpoint(s) manually.`
      : 'No etcd pods or services found — set a namespace or enter the endpoint(s) manually.');
}

module.exports = {
  KubeBridge, AgentTunnel, listContexts, listNamespaces,
  discoverPods, discoverServices, discoverEndpoints, DEFAULT_KUBECONFIG,
};
