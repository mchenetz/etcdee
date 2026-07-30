'use strict';

/* Pull etcd client certificates out of the cluster with the user's kubeconfig.
 *
 * OpenShift keeps them in openshift-etcd (secret/etcd-client +
 * configmap/etcd-ca-bundle) — the same thing `oc extract` fetches. Other
 * distributions that store etcd certs in secrets are matched by shape:
 * any secret carrying a tls.crt/tls.key pair in the etcd namespace.
 *
 * kubeadm/kind keep etcd certs on the control-plane node's filesystem, not
 * in the API, so those clusters have nothing to fetch — the caller is told
 * to copy the files off the node instead.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

let k8sPromise = null;
function k8sMod() {
  if (!k8sPromise) k8sPromise = import('@kubernetes/client-node');
  return k8sPromise;
}

async function coreClient(configPath, context) {
  const k8s = await k8sMod();
  const kc = new k8s.KubeConfig();
  kc.loadFromFile(configPath || path.join(os.homedir(), '.kube', 'config'));
  if (context) kc.setCurrentContext(context);
  return kc.makeApiClient(k8s.CoreV1Api);
}

const isNotFound = (err) => err && (err.code === 404 || err.statusCode === 404);
const decode = (v) => Buffer.from(v, 'base64').toString('utf8');

const CERT_KEYS = ['tls.crt', 'client.crt', 'etcd-client.crt'];
const KEY_KEYS = ['tls.key', 'client.key', 'etcd-client.key'];
const CA_KEYS = ['ca-bundle.crt', 'ca.crt', 'tls.crt', 'ca-bundle.pem'];

function pick(data, candidates) {
  for (const k of candidates) if (data && data[k]) return { key: k, value: data[k] };
  return null;
}

/**
 * @returns {Promise<{caFile,certFile,keyFile,source,dir}>}
 */
async function fetchEtcdCerts({ configPath, context, namespace, outDir } = {}) {
  const core = await coreClient(configPath, context);
  const namespaces = namespace ? [namespace] : ['openshift-etcd', 'etcd', 'kube-system'];

  let found = null;
  const tried = [];

  for (const ns of namespaces) {
    let secrets;
    try {
      const res = await core.listNamespacedSecret({ namespace: ns });
      secrets = res.items || [];
    } catch (err) {
      tried.push(`${ns}: ${isNotFound(err) ? 'no such namespace' : (err.body?.message || err.message)}`);
      continue;
    }

    // Prefer the canonical client secret, then any secret shaped like one.
    const ranked = secrets.slice().sort((a, b) => score(b) - score(a));
    const client = ranked.find((s) => pick(s.data, CERT_KEYS) && pick(s.data, KEY_KEYS));
    if (!client) { tried.push(`${ns}: no secret with a client cert/key pair`); continue; }

    const cert = pick(client.data, CERT_KEYS);
    const key = pick(client.data, KEY_KEYS);

    // CA: prefer a configmap bundle, fall back to a key inside the secret.
    let ca = null;
    let caSource = null;
    for (const cmName of ['etcd-ca-bundle', 'etcd-serving-ca', 'etcd-peer-client-ca']) {
      try {
        const cm = await core.readNamespacedConfigMap({ name: cmName, namespace: ns });
        const hit = pick(cm.data ? mapToBase64(cm.data) : null, CA_KEYS);
        if (hit) { ca = hit; caSource = `configmap/${cmName}`; break; }
      } catch (_) { /* try the next one */ }
    }
    if (!ca && client.data['ca.crt']) {
      ca = { key: 'ca.crt', value: client.data['ca.crt'] };
      caSource = `secret/${client.metadata.name}`;
    }

    found = {
      namespace: ns,
      secret: client.metadata.name,
      cert, key, ca, caSource,
    };
    break;
  }

  if (!found) {
    throw new Error(
      'No etcd client certificates found in the cluster API. ' +
      `Tried — ${tried.join('; ')}. ` +
      'kubeadm and kind keep etcd certs on the control-plane node instead: copy ' +
      '/etc/kubernetes/pki/etcd/ca.crt and /etc/kubernetes/pki/apiserver-etcd-client.{crt,key} off the node.'
    );
  }

  const dir = outDir || path.join(os.tmpdir(), 'etcdee-certs');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const write = (name, b64) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, decode(b64), { mode: 0o600 });
    return file;
  };

  const result = {
    certFile: write(`${found.namespace}-client.crt`, found.cert.value),
    keyFile: write(`${found.namespace}-client.key`, found.key.value),
    caFile: found.ca ? write(`${found.namespace}-ca.crt`, found.ca.value) : '',
    source: `secret/${found.secret} in ${found.namespace}` +
      (found.caSource ? ` (CA from ${found.caSource})` : ' (no CA found — etcd may reject the handshake)'),
    dir,
  };
  return result;
}

// ConfigMap data is plain text; normalize to the base64 shape used by Secrets.
function mapToBase64(data) {
  const out = {};
  for (const [k, v] of Object.entries(data)) out[k] = Buffer.from(v, 'utf8').toString('base64');
  return out;
}

function score(secret) {
  const name = secret.metadata?.name || '';
  if (name === 'etcd-client') return 100;
  if (name.startsWith('etcd-client')) return 90;
  if (name.includes('etcd') && name.includes('client')) return 80;
  if (name.includes('etcd')) return 50;
  return 0;
}

module.exports = { fetchEtcdCerts };
