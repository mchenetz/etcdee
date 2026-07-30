'use strict';

/* Kubernetes port-forward smoke test. Requires a reachable cluster with an
 * etcd pod. Configure with env vars:
 *   KUBECONFIG_PATH  kubeconfig file (default: ~/.kube/config)
 *   KUBE_CONTEXT     context name (default: current context)
 *   ETCD_CA / ETCD_CERT / ETCD_KEY   client TLS files (omit for plain etcd)
 *
 * Example against a kind cluster:
 *   docker cp <node>:/etc/kubernetes/pki/etcd/ca.crt ca.crt
 *   docker cp <node>:/etc/kubernetes/pki/apiserver-etcd-client.crt client.crt
 *   docker cp <node>:/etc/kubernetes/pki/apiserver-etcd-client.key client.key
 *   KUBECONFIG_PATH=... ETCD_CA=ca.crt ETCD_CERT=client.crt ETCD_KEY=client.key \
 *     node test/kube-smoke.js
 */

const assert = require('assert');
const { listContexts, discoverPods } = require('../lib/kube-bridge');
const { EtcdService } = require('../lib/etcd-service');

async function main() {
  const configPath = process.env.KUBECONFIG_PATH || null;
  const context = process.env.KUBE_CONTEXT || null;
  const log = (m) => console.log('ok:', m);

  const ctx = await listContexts({ configPath });
  assert(ctx.contexts.length > 0, 'kubeconfig has contexts');
  log(`contexts: ${ctx.contexts.map((c) => c.name + (c.current ? '*' : '')).join(', ')}`);

  const disc = await discoverPods({ configPath, context });
  assert(disc.pods.length > 0, 'found at least one etcd pod');
  const pod = disc.pods.find((p) => p.phase === 'Running') || disc.pods[0];
  log(`discovered ${disc.pods.length} etcd pod(s); using ${pod.namespace}/${pod.name}`);

  const tls = Boolean(process.env.ETCD_CA || process.env.ETCD_CERT);
  const svc = new EtcdService();
  const status = await svc.connect({
    kube: {
      enabled: true, configPath, context,
      namespace: pod.namespace, pod: pod.name,
      remotePort: Number(process.env.ETCD_POD_PORT || 2379),
    },
    tls,
    caFile: process.env.ETCD_CA || '',
    certFile: process.env.ETCD_CERT || '',
    keyFile: process.env.ETCD_KEY || '',
  });
  log(`connected through port-forward — etcd ${status.version}, revision ${status.revision}`);

  await svc.putKey({ key: '/etcdee-kube-smoke', value: 'tunnel' });
  const got = await svc.getKey({ key: '/etcdee-kube-smoke' });
  assert.strictEqual(got.value.text, 'tunnel', 'roundtrip through tunnel');
  await svc.deleteKey({ key: '/etcdee-kube-smoke' });
  log('put/get/delete through tunnel');

  const cluster = await svc.clusterOverview();
  assert(cluster.members.length >= 1);
  log(`clusterOverview: ${cluster.members.map((m) => m.name).join(', ')}`);

  await svc.disconnect();
  log('disconnect (tunnel closed)');
  console.log('\nKUBE SMOKE PASSED');
  // The Kubernetes client keeps keep-alive sockets to the API server open;
  // exit explicitly rather than waiting for them to time out.
  process.exit(0);
}

main().catch((err) => { console.error('KUBE SMOKE FAILED:', err.message); process.exit(1); });
