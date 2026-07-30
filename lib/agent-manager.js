'use strict';

/* Deploys and manages the in-cluster etcdee-agent using only the user's
 * kubeconfig: Namespace + Secret (auth token) + ConfigMap (agent source,
 * from agent/agent.js) + Deployment (stock node:alpine image). Nothing to
 * build or push anywhere. */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const AGENT_SOURCE = path.join(__dirname, '..', 'agent', 'agent.js');
const LABELS = { app: 'etcdee-agent', 'app.kubernetes.io/managed-by': 'etcdee' };
const AGENT_PORT = 8080;
const DEFAULT_IMAGE = 'node:22-alpine';

let k8sPromise = null;
function k8sMod() {
  if (!k8sPromise) k8sPromise = import('@kubernetes/client-node');
  return k8sPromise;
}

async function clients(configPath, context) {
  const k8s = await k8sMod();
  const kc = new k8s.KubeConfig();
  kc.loadFromFile(configPath || path.join(require('os').homedir(), '.kube', 'config'));
  if (context) kc.setCurrentContext(context);
  return { core: kc.makeApiClient(k8s.CoreV1Api), apps: kc.makeApiClient(k8s.AppsV1Api) };
}

const isConflict = (err) => err && (err.code === 409 || err.statusCode === 409);
const isNotFound = (err) => err && (err.code === 404 || err.statusCode === 404);

async function ensureAgent({ configPath, context, namespace = 'etcdee-agent', image = DEFAULT_IMAGE, allowedPorts = '2379,2380' } = {}) {
  const { core, apps } = await clients(configPath, context);
  const source = fs.readFileSync(AGENT_SOURCE, 'utf8');

  // Namespace
  try {
    await core.createNamespace({ body: { metadata: { name: namespace, labels: LABELS } } });
  } catch (err) { if (!isConflict(err)) throw wrap(err, 'create namespace'); }

  // Secret: keep an existing token so redeploys don't invalidate it
  let token;
  try {
    const existing = await core.readNamespacedSecret({ name: 'etcdee-agent-token', namespace });
    token = Buffer.from(existing.data.token, 'base64').toString('utf8');
  } catch (err) {
    if (!isNotFound(err)) throw wrap(err, 'read secret');
    token = crypto.randomBytes(32).toString('hex');
    await core.createNamespacedSecret({
      namespace,
      body: {
        metadata: { name: 'etcdee-agent-token', namespace, labels: LABELS },
        stringData: { token },
      },
    });
  }

  // ConfigMap with the agent source
  const cmBody = {
    metadata: { name: 'etcdee-agent-src', namespace, labels: LABELS },
    data: { 'agent.js': source },
  };
  try {
    await core.createNamespacedConfigMap({ namespace, body: cmBody });
  } catch (err) {
    if (!isConflict(err)) throw wrap(err, 'create configmap');
    await core.replaceNamespacedConfigMap({ name: 'etcdee-agent-src', namespace, body: cmBody });
  }

  // Deployment
  const deployBody = {
    metadata: { name: 'etcdee-agent', namespace, labels: LABELS },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: 'etcdee-agent' } },
      template: {
        metadata: {
          labels: LABELS,
          // Restarts pick up ConfigMap changes on redeploy
          annotations: { 'etcdee.io/source-hash': crypto.createHash('sha256').update(source).digest('hex').slice(0, 16) },
        },
        spec: {
          containers: [{
            name: 'agent',
            image,
            command: ['node', '/etcdee/agent.js'],
            ports: [{ containerPort: AGENT_PORT }],
            env: [
              { name: 'ETCDEE_AGENT_TOKEN', valueFrom: { secretKeyRef: { name: 'etcdee-agent-token', key: 'token' } } },
              { name: 'ETCDEE_AGENT_PORT', value: String(AGENT_PORT) },
              { name: 'ETCDEE_ALLOWED_PORTS', value: String(allowedPorts) },
            ],
            volumeMounts: [{ name: 'src', mountPath: '/etcdee', readOnly: true }],
            readinessProbe: { httpGet: { path: '/healthz', port: AGENT_PORT }, initialDelaySeconds: 1, periodSeconds: 3 },
            resources: {
              requests: { cpu: '10m', memory: '32Mi' },
              limits: { memory: '128Mi' },
            },
            securityContext: { runAsNonRoot: true, runAsUser: 1000, allowPrivilegeEscalation: false },
          }],
          volumes: [{ name: 'src', configMap: { name: 'etcdee-agent-src' } }],
        },
      },
    },
  };
  try {
    await apps.createNamespacedDeployment({ namespace, body: deployBody });
  } catch (err) {
    if (!isConflict(err)) throw wrap(err, 'create deployment');
    await apps.replaceNamespacedDeployment({ name: 'etcdee-agent', namespace, body: deployBody });
  }

  // Wait for a ready pod
  const pod = await waitForPod(core, namespace, 120000);
  return { namespace, pod: pod.metadata.name, token, agentPort: AGENT_PORT };
}

async function waitForPod(core, namespace, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = 'no pod yet';
  while (Date.now() < deadline) {
    const res = await core.listNamespacedPod({ namespace, labelSelector: 'app=etcdee-agent' });
    // Prefer a Ready pod from the newest generation
    const pods = (res.items || []).filter((p) => !p.metadata.deletionTimestamp);
    for (const p of pods) {
      const ready = (p.status?.conditions || []).some((c) => c.type === 'Ready' && c.status === 'True');
      if (p.status?.phase === 'Running' && ready) return p;
      last = `${p.metadata.name}: ${p.status?.phase || 'Pending'}`;
      const waitReason = p.status?.containerStatuses?.[0]?.state?.waiting?.reason;
      if (waitReason) last += ` (${waitReason})`;
      if (waitReason === 'ImagePullBackOff' || waitReason === 'ErrImagePull') {
        throw new Error(`agent image cannot be pulled — ${last}`);
      }
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`agent pod did not become ready in time (${last})`);
}

async function agentStatus({ configPath, context, namespace = 'etcdee-agent' } = {}) {
  const { core } = await clients(configPath, context);
  try {
    const res = await core.listNamespacedPod({ namespace, labelSelector: 'app=etcdee-agent' });
    const pods = res.items || [];
    if (pods.length === 0) return { deployed: false };
    const pod = pods.find((p) =>
      (p.status?.conditions || []).some((c) => c.type === 'Ready' && c.status === 'True')) || pods[0];
    const ready = (pod.status?.conditions || []).some((c) => c.type === 'Ready' && c.status === 'True');
    return { deployed: true, pod: pod.metadata.name, phase: pod.status?.phase, ready };
  } catch (err) {
    if (isNotFound(err)) return { deployed: false };
    throw wrap(err, 'check agent');
  }
}

async function readToken({ configPath, context, namespace = 'etcdee-agent' } = {}) {
  const { core } = await clients(configPath, context);
  const secret = await core.readNamespacedSecret({ name: 'etcdee-agent-token', namespace });
  return Buffer.from(secret.data.token, 'base64').toString('utf8');
}

async function removeAgent({ configPath, context, namespace = 'etcdee-agent' } = {}) {
  const { core, apps } = await clients(configPath, context);
  const results = [];
  const attempt = async (what, fn) => {
    try { await fn(); results.push(what); }
    catch (err) { if (!isNotFound(err)) throw wrap(err, `delete ${what}`); }
  };
  await attempt('deployment', () => apps.deleteNamespacedDeployment({ name: 'etcdee-agent', namespace }));
  await attempt('configmap', () => core.deleteNamespacedConfigMap({ name: 'etcdee-agent-src', namespace }));
  await attempt('secret', () => core.deleteNamespacedSecret({ name: 'etcdee-agent-token', namespace }));
  // Only remove the namespace if etcdee created it (it carries our label)
  try {
    const ns = await core.readNamespace({ name: namespace });
    if (ns.metadata?.labels?.['app.kubernetes.io/managed-by'] === 'etcdee') {
      await attempt('namespace', () => core.deleteNamespace({ name: namespace }));
    }
  } catch (err) { if (!isNotFound(err)) throw wrap(err, 'read namespace'); }
  return { removed: results };
}

function wrap(err, what) {
  const detail = err.body?.message || err.message || String(err);
  return new Error(`Failed to ${what}: ${detail}`);
}

module.exports = { ensureAgent, agentStatus, removeAgent, readToken, AGENT_PORT };
