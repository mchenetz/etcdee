'use strict';

/* Smoke test: exercises EtcdService against a running etcd on
 * ETCD_ENDPOINT (default http://127.0.0.1:2379). Run with `npm run smoke`. */

const os = require('os');
const path = require('path');
const assert = require('assert');
const { EtcdService } = require('../lib/etcd-service');

const endpoint = process.env.ETCD_ENDPOINT || 'http://127.0.0.1:2379';

async function main() {
  const svc = new EtcdService();
  const log = (name) => console.log('ok:', name);

  const status = await svc.connect({ endpoints: endpoint });
  assert(status.version, 'connect returns version');
  log(`connect (etcd ${status.version})`);

  // CRUD
  await svc.putKey({ key: '/smoke/app/config', value: '{"debug":true}' });
  await svc.putKey({ key: '/smoke/app/name', value: 'etcdee' });
  await svc.putKey({ key: '/smoke/other', value: 'hello world' });
  log('put');

  const got = await svc.getKey({ key: '/smoke/app/config' });
  assert.strictEqual(got.found, true);
  assert.strictEqual(got.value.text, '{"debug":true}');
  assert.strictEqual(got.value.encoding, 'utf8');
  assert(got.modRevision && Number(got.version) >= 1, 'metadata present');
  log('get + metadata');

  // Binary round-trip
  const binary = Buffer.from([0, 1, 2, 250, 251]).toString('base64');
  await svc.putKey({ key: '/smoke/bin', value: binary, encoding: 'base64' });
  const gotBin = await svc.getKey({ key: '/smoke/bin' });
  assert.strictEqual(gotBin.value.encoding, 'base64');
  assert.strictEqual(gotBin.value.text, binary);
  log('binary value detection');

  const list = await svc.listKeys({ prefix: '/smoke/' });
  assert(list.keys.length >= 4, `expected >=4 keys, got ${list.keys.length}`);
  log(`listKeys (${list.keys.length} keys, revision ${list.revision})`);

  // Watch
  const events = [];
  await svc.startWatch({ id: 'w1', target: '/smoke/', isPrefix: true }, (e) => events.push(e));
  await svc.putKey({ key: '/smoke/watched', value: 'v1' });
  await svc.deleteKey({ key: '/smoke/watched' });
  await new Promise((r) => setTimeout(r, 500));
  await svc.stopWatch({ id: 'w1' });
  assert(events.some((e) => e.type === 'put' && e.key === '/smoke/watched'), 'watch saw put');
  assert(events.some((e) => e.type === 'delete' && e.key === '/smoke/watched'), 'watch saw delete');
  assert(events.find((e) => e.type === 'delete').prevValue.text === 'v1', 'watch prev value');
  log('watch put/delete with prev value');

  // Leases
  const lease = await svc.grantLease({ ttl: 60 });
  assert(lease.id !== '0', 'lease granted');
  await svc.putKey({ key: '/smoke/leased', value: 'x', leaseId: lease.id });
  const leases = await svc.listLeases();
  const mine = leases.leases.find((l) => l.id === lease.id);
  assert(mine, 'lease listed');
  assert(mine.keys.includes('/smoke/leased'), 'lease shows attached key');
  await svc.revokeLease({ id: lease.id });
  const afterRevoke = await svc.getKey({ key: '/smoke/leased' });
  assert.strictEqual(afterRevoke.found, false, 'key gone after lease revoke');
  log('lease grant/list/revoke');

  // Get at old revision
  await svc.putKey({ key: '/smoke/rev', value: 'one' });
  const rev1 = await svc.getKey({ key: '/smoke/rev' });
  await svc.putKey({ key: '/smoke/rev', value: 'two' });
  const old = await svc.getKey({ key: '/smoke/rev', revision: rev1.modRevision });
  assert.strictEqual(old.value.text, 'one', 'historical read');
  log('read at revision');

  // Cluster + maintenance
  const cluster = await svc.clusterOverview();
  assert(cluster.members.length >= 1, 'members listed');
  assert(cluster.members[0].status && cluster.members[0].status.version, 'member status probed');
  log(`clusterOverview (${cluster.members.length} member(s), leader=${cluster.members[0].status.isLeader})`);

  const alarms = await svc.listAlarms();
  assert(Array.isArray(alarms.alarms), 'alarms listed');
  log('alarms');

  const st = await svc.status();
  assert(st.dbSize && st.revision, 'status fields');
  log(`status (dbSize=${st.dbSize}, revision=${st.revision})`);

  const compacted = await svc.compact({});
  assert(compacted.ok, 'compact');
  log(`compact to revision ${compacted.revision}`);

  await svc.defragment();
  log('defragment');

  const snapPath = path.join(os.tmpdir(), `etcdee-smoke-${process.pid}.db`);
  const snap = await svc.snapshot({ filePath: snapPath }, () => {});
  assert(snap.bytes > 0, 'snapshot has bytes');
  require('fs').unlinkSync(snapPath);
  log(`snapshot (${snap.bytes} bytes)`);

  // Auth management (role + user lifecycle, auth stays disabled)
  const authBefore = await svc.authOverview();
  log(`authOverview (enabled=${authBefore.enabled})`);
  await svc.roleAdd({ name: 'smoke-role' });
  await svc.roleGrantPermission({ name: 'smoke-role', permission: 'Readwrite', key: '/smoke/', prefix: true });
  await svc.userAdd({ name: 'smoke-user', password: 'smoke-pass' });
  await svc.userGrantRole({ name: 'smoke-user', role: 'smoke-role' });
  const authAfter = await svc.authOverview();
  const u = authAfter.users.find((x) => x.name === 'smoke-user');
  assert(u && u.roles.includes('smoke-role'), 'user has role');
  const r = authAfter.roles.find((x) => x.name === 'smoke-role');
  assert(r && r.permissions.some((p) => p.key === '/smoke/'), 'role has permission');
  await svc.userRevokeRole({ name: 'smoke-user', role: 'smoke-role' });
  await svc.userDelete({ name: 'smoke-user' });
  await svc.roleDelete({ name: 'smoke-role' });
  log('auth user/role lifecycle');

  // Cleanup
  const del = await svc.deletePrefix({ prefix: '/smoke/' });
  log(`deletePrefix (${del.deleted} keys)`);

  await svc.disconnect();
  log('disconnect');
  console.log('\nALL SMOKE TESTS PASSED');
}

main().catch((err) => {
  console.error('SMOKE FAILED:', err);
  process.exit(1);
});
