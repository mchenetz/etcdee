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
    (labels['app.kubernetes.io/name'] || '').includes('etcd')
  ) return true;
  // Strongest signal: a container actually named etcd or running an etcd image.
  // (Matching the pod name alone misfires when the cluster name contains "etcd".)
  return (pod.spec?.containers || []).some((c) =>
    c.name === 'etcd' || /(^|\/)etcd(:|$|@)/.test(c.image || ''));
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
    ports,
  };
}

async function discoverPods({ configPath, context } = {}) {
  const k8s = await k8sMod();
  const kc = await loadConfig(configPath, context);
  const core = kc.makeApiClient(k8s.CoreV1Api);

  // Prefer a cluster-wide scan; fall back to likely namespaces when RBAC
  // forbids listing across all namespaces.
  try {
    const res = await core.listPodForAllNamespaces();
    return { pods: res.items.filter(looksLikeEtcd).map(podSummary) };
  } catch (err) {
    const namespaces = new Set(['kube-system', 'default', 'etcd']);
    const ctxNs = kc.getContexts().find((c) => c.name === kc.getCurrentContext())?.namespace;
    if (ctxNs) namespaces.add(ctxNs);
    const pods = [];
    let lastErr = err;
    for (const ns of namespaces) {
      try {
        const res = await core.listNamespacedPod({ namespace: ns });
        pods.push(...res.items.filter(looksLikeEtcd).map(podSummary));
      } catch (nsErr) { lastErr = nsErr; }
    }
    if (pods.length === 0) {
      throw new Error(`Could not list pods (${lastErr.body?.message || lastErr.message}). ` +
        'Check that the kubeconfig user may list pods.');
    }
    return { pods };
  }
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

module.exports = { KubeBridge, AgentTunnel, listContexts, discoverPods, DEFAULT_KUBECONFIG };
