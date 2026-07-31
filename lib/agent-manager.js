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

  // OpenShift allocates each namespace its own UID range and its SCCs reject
  // any runAsUser outside it. Detect that and let the SCC assign the UID.
  let openshift = false;
  try {
    const ns = await core.readNamespace({ name: namespace });
    openshift = Boolean(ns.metadata?.annotations?.['openshift.io/sa.scc.uid-range']);
  } catch (_) { /* fall back to the portable spec */ }

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
            // Satisfies the restricted Pod Security Standard and OpenShift's
            // restricted-v2 SCC. runAsUser is pinned only off-OpenShift, where
            // nothing would otherwise stop the image running as root.
            securityContext: {
              runAsNonRoot: true,
              ...(openshift ? {} : { runAsUser: 1000 }),
              allowPrivilegeEscalation: false,
              capabilities: { drop: ['ALL'] },
              seccompProfile: { type: 'RuntimeDefault' },
            },
          }],
          volumes: [{ name: 'src', configMap: { name: 'etcdee-agent-src' } }],
          // etcd normally runs on control-plane nodes, and a small cluster
          // may have nothing else. Tolerate those taints so the agent can
          // always be scheduled, but prefer an ordinary node when one exists.
          tolerations: [
            { key: 'node-role.kubernetes.io/control-plane', operator: 'Exists', effect: 'NoSchedule' },
            { key: 'node-role.kubernetes.io/master', operator: 'Exists', effect: 'NoSchedule' },
          ],
          affinity: {
            nodeAffinity: {
              preferredDuringSchedulingIgnoredDuringExecution: [{
                weight: 100,
                preference: {
                  matchExpressions: [
                    { key: 'node-role.kubernetes.io/control-plane', operator: 'DoesNotExist' },
                  ],
                },
              }],
            },
          },
        },
      },
    },
  };
  let deployed;
  try {
    deployed = await apps.createNamespacedDeployment({ namespace, body: deployBody });
  } catch (err) {
    if (!isConflict(err)) throw wrap(err, 'create deployment');
    // Carry the live resourceVersion so the update is a clean replace.
    const live = await apps.readNamespacedDeployment({ name: 'etcdee-agent', namespace });
    deployBody.metadata.resourceVersion = live.metadata.resourceVersion;
    deployed = await apps.replaceNamespacedDeployment({ name: 'etcdee-agent', namespace, body: deployBody });
  }

  // Wait for a ready pod belonging to the generation we just wrote
  const pod = await waitForPod(core, apps, namespace, deployed.metadata.generation, 120000);
  return { namespace, pod: pod.metadata.name, token, agentPort: AGENT_PORT, openshift };
}

const FATAL_WAITING = new Set(['ImagePullBackOff', 'ErrImagePull', 'InvalidImageName', 'CreateContainerConfigError']);

async function waitForPod(core, apps, namespace, generation, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = 'no pod created yet';
  while (Date.now() < deadline) {
    // Admission rejections (SCC, Pod Security, quota) show up on the
    // ReplicaSet within a second, long before any pod wait would expire.
    const current = await currentReplicaSet(apps, namespace);
    if (current?.failure) {
      throw new Error(`Kubernetes refused to create the agent pod — ${current.failure}`);
    }

    // Don't inspect pods until the controller has acted on the spec we just
    // wrote — until then the previous generation's pod is still Ready, and
    // returning it would tunnel to a pod that is about to terminate.
    const dep = await apps.readNamespacedDeployment({ name: 'etcdee-agent', namespace });
    const st = dep.status || {};
    const rolledOut = (st.observedGeneration || 0) >= generation &&
      (st.updatedReplicas || 0) >= 1 &&
      (st.replicas || 0) === (st.updatedReplicas || 0);
    if (!rolledOut) {
      last = `rolling out (observed ${st.observedGeneration || 0}/${generation}, ` +
        `${st.updatedReplicas || 0} updated, ${st.replicas || 0} total)`;
      await new Promise((r) => setTimeout(r, 1500));
      continue;
    }

    if (!current?.hash) {
      last = 'waiting for the deployment to create a replica set';
      await new Promise((r) => setTimeout(r, 1500));
      continue;
    }

    const res = await core.listNamespacedPod({
      namespace,
      labelSelector: `app=etcdee-agent,pod-template-hash=${current.hash}`,
    });
    const pods = (res.items || []).filter((p) => !p.metadata.deletionTimestamp);

    for (const p of pods) {
      const ready = (p.status?.conditions || []).some((c) => c.type === 'Ready' && c.status === 'True');
      if (p.status?.phase === 'Running' && ready) return p;
      const cs = p.status?.containerStatuses?.[0];
      const waiting = cs?.state?.waiting;
      last = `${p.metadata.name}: ${p.status?.phase || 'Pending'}`;
      if (waiting?.reason) last += ` (${waiting.reason}${waiting.message ? ': ' + waiting.message : ''})`;

      // A pod that cannot be scheduled never reports a container state, so
      // without this the wait just times out saying "Pending".
      const sched = (p.status?.conditions || [])
        .find((c) => c.type === 'PodScheduled' && c.status === 'False');
      if (sched?.reason === 'Unschedulable') {
        throw new Error(
          `the agent pod cannot be scheduled — ${sched.message || 'no node accepts it'}. ` +
          'Check node taints, quotas, and whether any node has capacity.');
      }
      if (waiting && FATAL_WAITING.has(waiting.reason)) {
        throw new Error(`agent container cannot start — ${last}`);
      }
      if (cs?.restartCount > 2) {
        throw new Error(`agent container keeps crashing — ${last}`);
      }
    }

    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`agent pod did not become ready in time (${last})`);
}

/**
 * The ReplicaSet the Deployment is currently rolling out, with its
 * pod-template-hash and any admission failure. Admission rejections (SCC,
 * Pod Security, quota) surface here instantly — long before the pod wait
 * would time out — so the caller can fail fast with the real reason.
 */
async function currentReplicaSet(apps, namespace) {
  const revision = (rs) => Number(rs.metadata?.annotations?.['deployment.kubernetes.io/revision'] || 0);
  try {
    const res = await apps.listNamespacedReplicaSet({ namespace, labelSelector: 'app=etcdee-agent' });
    const active = (res.items || []).filter((rs) => (rs.spec?.replicas || 0) > 0);
    if (active.length === 0) return null;
    const newest = active.sort((a, b) => revision(b) - revision(a))[0];
    const failed = (newest.status?.conditions || [])
      .find((c) => c.type === 'ReplicaFailure' && c.status === 'True');
    return {
      hash: newest.metadata?.labels?.['pod-template-hash'] || null,
      failure: failed ? summarizeAdmission(failed.message || failed.reason || 'unknown reason') : null,
    };
  } catch (_) {
    return null; // diagnostics are best-effort; fall back to the pod wait
  }
}

/**
 * OpenShift lists every SCC it tried, which buries the real cause in a wall
 * of "not usable by user or serviceaccount". Keep the clauses that say what
 * is actually wrong.
 */
function summarizeAdmission(message) {
  if (!message.includes('security context constraint')) return message;
  const useful = message
    .split(/,\s*(?=provider)/)
    .map((part) => part.trim())
    .filter((part) => part.includes('Invalid value') || part.includes('must be') || part.includes('Host Users'));
  if (useful.length === 0) {
    return `${message.slice(0, 200)}… (no SCC permits this pod; ask a cluster admin which SCC your account may use)`;
  }
  return useful.join('; ');
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
