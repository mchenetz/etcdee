'use strict';

/* etcdee renderer — plain DOM, no framework.
 * All etcd calls go through window.etcdee (preload bridge); every call
 * returns { ok, data | error } and errors surface as toasts. */

const api = window.etcdee;

// ------------------------------------------------------------------ helpers

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const child of children.flat()) {
    if (child == null) continue;
    node.append(child.nodeType ? child : document.createTextNode(child));
  }
  return node;
}

function toast(message, kind = 'ok') {
  const box = el('div', { class: `toast ${kind === 'ok' ? '' : kind}`, role: 'status' }, message);
  $('#toasts').append(box);
  setTimeout(() => box.remove(), kind === 'error' ? 7000 : 4000);
}

async function call(fn, args) {
  const res = await fn(args);
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

function guard(promiseFn) {
  // Wrap an async handler: failures become error toasts instead of silence.
  return async (...args) => {
    try { return await promiseFn(...args); }
    catch (err) { toast(err.message, 'error'); }
  };
}

function fmtBytes(n) {
  n = Number(n);
  if (!isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MiB`;
  return `${(n / 1024 ** 3).toFixed(2)} GiB`;
}

const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour12: false });

function shortId(id) {
  // etcd member/lease ids are decimal int64 strings; hex is the familiar form
  try { return BigInt(id).toString(16); } catch (_) { return id; }
}

// Generic confirm dialog. Returns true when confirmed.
function confirmDialog({ title, body, confirmText = 'Confirm', typeToConfirm = null }) {
  return new Promise((resolve) => {
    const dlg = $('#dlg-confirm');
    $('#dlg-confirm-title').textContent = title;
    const bodyEl = $('#dlg-confirm-body');
    bodyEl.textContent = '';
    if (typeof body === 'string') bodyEl.append(body);
    else bodyEl.append(body);

    const okBtn = $('#dlg-confirm-ok');
    okBtn.textContent = confirmText;

    let input = null;
    if (typeToConfirm) {
      input = el('input', {
        type: 'text', class: 'mono', style: 'width:100%;margin-top:10px',
        'aria-label': `Type ${typeToConfirm} to confirm`, placeholder: typeToConfirm,
      });
      okBtn.disabled = true;
      input.addEventListener('input', () => { okBtn.disabled = input.value !== typeToConfirm; });
      bodyEl.append(
        el('div', { style: 'margin-top:10px' }, 'Type ', el('strong', { class: 'mono' }, typeToConfirm), ' to confirm:'),
        input
      );
    } else {
      okBtn.disabled = false;
    }

    const done = (result) => {
      dlg.close();
      okBtn.removeEventListener('click', onOk);
      dlg.removeEventListener('close', onClose);
      resolve(result);
    };
    const onOk = () => done(true);
    const onClose = () => done(false);
    okBtn.addEventListener('click', onOk);
    dlg.addEventListener('close', onClose);
    dlg.showModal();
    (input || okBtn).focus();
  });
}

// Dialog plumbing: any [data-close] button closes its dialog.
$$('dialog').forEach((dlg) => {
  dlg.querySelectorAll('[data-close]').forEach((btn) =>
    btn.addEventListener('click', () => dlg.close()));
});

// --------------------------------------------------------------------- state

const state = {
  profiles: [],
  selectedProfile: -1,
  connected: false,
  connInfo: null,
  view: 'connect',
  keys: [],           // [{key, modRevision, ...}]
  expanded: new Set(),
  selectedKey: null,
  editor: { dirty: false, encoding: 'utf8', loadedRev: null, view: 'raw', info: null },
  watching: false,
};

// --------------------------------------------------------------------- theme

const THEME_KEY = 'etcdee-theme';
function applyTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved) document.documentElement.dataset.theme = saved;
  else {
    const light = window.matchMedia('(prefers-color-scheme: light)').matches;
    document.documentElement.dataset.theme = light ? 'light' : 'dark';
  }
}
$('#btn-theme').addEventListener('click', () => {
  const cur = document.documentElement.dataset.theme;
  const next = cur === 'light' ? 'dark' : 'light';
  localStorage.setItem(THEME_KEY, next);
  document.documentElement.dataset.theme = next;
});
applyTheme();

// --------------------------------------------------------------------- views

const VIEW_ORDER = ['keys', 'watch', 'leases', 'cluster', 'maint', 'auth', 'connect'];

function showView(name) {
  state.view = name;
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  $$('.nav-item').forEach((b) => {
    if (b.dataset.view === name) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  const refreshers = {
    keys: () => state.keys.length === 0 && refreshKeys(),
    leases: refreshLeases,
    cluster: refreshCluster,
    maint: refreshMaint,
    auth: refreshAuth,
  };
  if (state.connected && refreshers[name]) guard(refreshers[name])();
}

$$('.nav-item').forEach((btn) =>
  btn.addEventListener('click', () => showView(btn.dataset.view)));

function setConnected(connected, profile) {
  state.connected = connected;
  $$('.nav-item').forEach((b) => {
    if (b.dataset.view !== 'connect') b.disabled = !connected;
  });
  const chip = $('#conn-chip');
  chip.classList.toggle('on', connected);
  $('#conn-chip-text').textContent = connected
    ? `${profile.name || describeTarget(profile)} · etcd ${state.connInfo.version}`
    : 'not connected';
  $('#btn-disconnect').classList.toggle('hidden', !connected);
}

$('#btn-disconnect').addEventListener('click', guard(async () => {
  await call(api.conn.disconnect);
  state.keys = [];
  state.selectedKey = null;
  state.watching = false;
  $('#btn-watch-toggle').textContent = 'Start watch';
  renderTree();
  renderEditor(null);
  setConnected(false);
  showView('connect');
  toast('Disconnected');
}));

// ------------------------------------------------------------------ profiles

function describeTarget(p) {
  if (p.kube && p.kube.enabled) {
    return p.kube.mode === 'agent'
      ? `⎈ agent → ${p.endpoints || '?'}`
      : `⎈ ${p.kube.namespace}/${p.kube.pod}`;
  }
  return p.endpoints;
}

function readForm() {
  return {
    name: $('#cf-name').value.trim(),
    endpoints: $('#cf-endpoints').value.trim(),
    username: $('#cf-username').value.trim(),
    password: $('#cf-password').value,
    tls: $('#cf-tls').checked,
    caFile: $('#cf-ca').value.trim(),
    certFile: $('#cf-cert').value.trim(),
    keyFile: $('#cf-key').value.trim(),
    kube: {
      enabled: $('#cf-kube').checked,
      mode: document.querySelector('input[name="cf-kube-mode"]:checked')?.value || 'portforward',
      configPath: $('#cf-kubeconfig').value.trim(),
      context: $('#cf-kube-context').value,
      namespace: $('#cf-kube-pod').value.split('/')[0] || '',
      pod: $('#cf-kube-pod').value.split('/')[1] || '',
      remotePort: Number($('#cf-kube-port').value) || 2379,
      // Where to look for etcd — independent of where the agent itself runs.
      searchNamespace: $('#cf-kube-ns').value.trim(),
      allPods: $('#cf-kube-allpods').checked,
      agentNamespace: $('#cf-agent-ns').value.trim() || 'etcdee-agent',
    },
  };
}

function fillForm(p) {
  $('#cf-name').value = p.name || '';
  $('#cf-endpoints').value = p.endpoints || '';
  $('#cf-username').value = p.username || '';
  $('#cf-password').value = p.password || '';
  $('#cf-tls').checked = Boolean(p.tls);
  $('#cf-ca').value = p.caFile || '';
  $('#cf-cert').value = p.certFile || '';
  $('#cf-key').value = p.keyFile || '';
  $('#cf-tls-files').classList.toggle('hidden', !p.tls);

  const kube = p.kube || {};
  $('#cf-kube').checked = Boolean(kube.enabled);
  $('#cf-kubeconfig').value = kube.configPath || '';
  setSelect($('#cf-kube-context'), kube.context, kube.context || '— load contexts —');
  const podValue = kube.namespace && kube.pod ? `${kube.namespace}/${kube.pod}` : '';
  setSelect($('#cf-kube-pod'), podValue, podValue || '— discover pods —');
  $('#cf-kube-port').value = kube.remotePort || 2379;
  $('#cf-kube-ns').value = kube.searchNamespace || '';
  $('#cf-kube-allpods').checked = Boolean(kube.allPods);
  const mode = kube.mode === 'agent' ? 'agent' : 'portforward';
  document.querySelector(`input[name="cf-kube-mode"][value="${mode}"]`).checked = true;
  $('#cf-agent-ns').value = kube.agentNamespace || 'etcdee-agent';
  $('#agent-status').textContent = '';
  syncKubeMode();
}

// Reset a <select> to hold (and select) a single known value, keeping a
// placeholder label when there is none. Real options load on demand.
function setSelect(sel, value, label) {
  sel.textContent = '';
  sel.append(el('option', { value: value || '' }, label));
  sel.value = value || '';
}

function syncKubeMode() {
  const on = $('#cf-kube').checked;
  const mode = document.querySelector('input[name="cf-kube-mode"]:checked')?.value || 'portforward';
  const agentMode = on && mode === 'agent';
  const pfMode = on && mode === 'portforward';
  $('#cf-kube-fields').classList.toggle('hidden', !on);
  $('#cf-kube-pf-row').classList.toggle('hidden', !pfMode && on);
  $('#cf-kube-agent-row').classList.toggle('hidden', !agentMode);
  const endpoints = $('#cf-endpoints');
  // In agent mode 127.0.0.1 would mean "etcd inside the agent pod", which is
  // never true. Drop a leftover loopback address so auto-discovery kicks in.
  if (agentMode && /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/i.test(endpoints.value.trim())) {
    endpoints.value = '';
  }
  endpoints.disabled = pfMode;
  endpoints.placeholder = pfMode
    ? 'not used — the port-forward sets this'
    : agentMode
      ? 'leave blank to auto-discover every etcd pod, or list in-cluster addresses'
      : 'http://127.0.0.1:2379, http://127.0.0.1:22379';

  // Endpoints are only mandatory for a direct connection.
  endpoints.closest('label').querySelector('.req').classList.toggle('hidden', on);
  const note = $('#cf-endpoints-note');
  note.classList.toggle('hidden', !on);
  note.textContent = pfMode ? ' — not used in port-forward mode' : ' — optional, auto-discovered';

  $('#btn-fetch-certs').classList.toggle('hidden', !on);
}

function renderProfiles() {
  const list = $('#profile-list');
  list.textContent = '';
  if (state.profiles.length === 0) {
    list.append(el('div', { class: 'dim', style: 'font-size:12.5px;padding:4px 2px' },
      'No saved profiles yet. Fill in the form and press “Save profile”.'));
  }
  state.profiles.forEach((p, i) => {
    list.append(el('button', {
      class: 'profile-card', role: 'listitem',
      'aria-pressed': String(i === state.selectedProfile),
      onclick: () => { state.selectedProfile = i; fillForm(p); renderProfiles(); $('#btn-delete-profile').classList.remove('hidden'); },
      ondblclick: () => connect(),
    },
      el('div', {},
        el('div', { class: 'p-name' }, p.name || '(unnamed)'),
        el('div', { class: 'p-endpoints' }, describeTarget(p))),
    ));
  });
  $('#btn-delete-profile').classList.toggle('hidden', state.selectedProfile < 0);
}

$('#btn-new-profile').addEventListener('click', () => {
  state.selectedProfile = -1;
  fillForm({ endpoints: 'http://127.0.0.1:2379' });
  renderProfiles();
  $('#cf-name').focus();
});

$('#cf-tls').addEventListener('change', () =>
  $('#cf-tls-files').classList.toggle('hidden', !$('#cf-tls').checked));

$('#cf-kube').addEventListener('change', syncKubeMode);
$$('input[name="cf-kube-mode"]').forEach((r) => r.addEventListener('change', syncKubeMode));

function kubeOptsFromForm() {
  return {
    configPath: $('#cf-kubeconfig').value.trim() || null,
    context: $('#cf-kube-context').value || null,
    namespace: $('#cf-agent-ns').value.trim() || 'etcdee-agent',
  };
}

$('#btn-kube-endpoints').addEventListener('click', guard(async () => {
  const res = await call(api.kube.endpoints, {
    ...searchOpts(),
    port: Number($('#cf-kube-port').value) || 2379,
    tls: $('#cf-tls').checked,
  });
  $('#cf-endpoints').value = res.endpoints.join(', ');
  toast(`Filled ${res.endpoints.length} etcd endpoint(s)`);
}));

$('#btn-fetch-certs').addEventListener('click', guard(async () => {
  const btn = $('#btn-fetch-certs');
  const out = $('#cert-fetch-status');
  btn.disabled = true;
  out.textContent = 'searching cluster…';
  try {
    const res = await call(api.kube.fetchCerts, {
      configPath: $('#cf-kubeconfig').value.trim() || null,
      context: $('#cf-kube-context').value || null,
    });
    $('#cf-tls').checked = true;
    $('#cf-tls-files').classList.remove('hidden');
    $('#cf-ca').value = res.caFile;
    $('#cf-cert').value = res.certFile;
    $('#cf-key').value = res.keyFile;
    out.textContent = `from ${res.source}`;
    toast(`Loaded etcd certs from ${res.source}`);
  } catch (err) {
    out.textContent = '';
    throw err;
  } finally {
    btn.disabled = false;
  }
}));

/**
 * Ports the agent must be allowed to reach: etcd's standard pair, whatever
 * port the form is configured for, and anything named in the endpoints
 * field. The agent refuses everything else, so this has to be right at
 * deploy time.
 */
async function agentAllowedPorts() {
  const ports = new Set([2379, 2380]);
  const configured = Number($('#cf-kube-port').value);
  if (configured > 0) ports.add(configured);
  for (const raw of $('#cf-endpoints').value.split(',')) {
    const m = /:(\d+)\s*$/.exec(raw.trim());
    if (m) ports.add(Number(m[1]));
  }
  // Members usually advertise the port the pods listen on rather than the
  // one a service publishes (Portworx kvdb advertises 17016 behind 9019),
  // so include service target ports or the Cluster view cannot probe them.
  try {
    const res = await call(api.kube.services, {
      ...searchOpts(),
      port: configured || null,
    });
    for (const s of res.services) {
      if (Number(s.targetPort) > 0) ports.add(Number(s.targetPort));
    }
  } catch (_) { /* best effort — the explicit ports still apply */ }
  return [...ports].sort((a, b) => a - b).join(',');
}

$('#btn-agent-deploy').addEventListener('click', guard(async () => {
  const btn = $('#btn-agent-deploy');
  const out = $('#agent-status');
  btn.disabled = true;
  out.textContent = 'checking ports…';
  const allowedPorts = await agentAllowedPorts();
  out.textContent = 'deploying… (first run pulls node:alpine)';
  try {
    const res = await call(api.agent.ensure, { ...kubeOptsFromForm(), allowedPorts });
    out.textContent = `ready: ${res.pod} · ports ${allowedPorts}`;
    toast(`Agent ready in ${res.namespace} (ports ${allowedPorts})`);
  } catch (err) {
    out.textContent = 'deploy failed';
    throw err;
  } finally {
    btn.disabled = false;
  }
}));

$('#btn-agent-check').addEventListener('click', guard(async () => {
  const res = await call(api.agent.status, kubeOptsFromForm());
  $('#agent-status').textContent = res.deployed
    ? `${res.pod}: ${res.phase}${res.ready ? ' (ready)' : ' (not ready)'}`
    : 'not deployed';
}));

$('#btn-agent-remove').addEventListener('click', guard(async () => {
  const opts = kubeOptsFromForm();
  const yes = await confirmDialog({
    title: 'Remove in-cluster agent?',
    body: `Deletes the etcdee-agent deployment, config, and token secret from namespace “${opts.namespace}” (and the namespace itself if etcdee created it).`,
    confirmText: 'Remove agent',
  });
  if (!yes) return;
  const res = await call(api.agent.remove, opts);
  $('#agent-status').textContent = 'not deployed';
  toast(res.removed.length ? `Removed: ${res.removed.join(', ')}` : 'Nothing to remove');
}));

$('#btn-kube-contexts').addEventListener('click', guard(async () => {
  const res = await call(api.kube.contexts, { configPath: $('#cf-kubeconfig').value.trim() || null });
  const sel = $('#cf-kube-context');
  sel.textContent = '';
  for (const c of res.contexts) {
    sel.append(el('option', { value: c.name }, `${c.name}${c.current ? '  (current)' : ''}`));
  }
  const current = res.contexts.find((c) => c.current);
  if (current) sel.value = current.name;
  toast(`${res.contexts.length} context(s) in ${res.path}`);
}));

// Where to look for etcd. Namespace is free text so it still works when the
// kubeconfig user may not list namespaces cluster-wide.
function searchOpts() {
  return {
    configPath: $('#cf-kubeconfig').value.trim() || null,
    context: $('#cf-kube-context').value || null,
    namespace: $('#cf-kube-ns').value.trim() || null,
    includeAll: $('#cf-kube-allpods').checked,
  };
}

$('#btn-kube-namespaces').addEventListener('click', guard(async () => {
  const res = await call(api.kube.namespaces, {
    configPath: $('#cf-kubeconfig').value.trim() || null,
    context: $('#cf-kube-context').value || null,
  });
  const list = $('#kube-namespaces');
  list.textContent = '';
  for (const ns of res.namespaces) list.append(el('option', { value: ns }));
  toast(`${res.namespaces.length} namespace(s) — type or pick one`);
}));

$('#btn-kube-discover').addEventListener('click', guard(async () => {
  const btn = $('#btn-kube-discover');
  btn.disabled = true;
  try {
    const res = await call(api.kube.discover, searchOpts());
    const sel = $('#cf-kube-pod');
    sel.textContent = '';
    if (res.pods.length === 0) {
      setSelect(sel, '', 'no pods found');
      toast('No matching pods — try a namespace, or tick “list every pod”', 'warn');
      return;
    }
    // etcd-like pods first so the likely choice is preselected.
    const pods = res.pods.slice().sort((a, b) => (b.etcdLike ? 1 : 0) - (a.etcdLike ? 1 : 0));
    for (const p of pods) {
      const ports = p.ports.length ? ` :${p.ports.join(',')}` : '';
      const flags = [
        p.etcdLike ? null : 'not etcd-like',
        p.phase !== 'Running' ? p.phase : null,
      ].filter(Boolean);
      sel.append(el('option', { value: `${p.namespace}/${p.name}` },
        `${p.namespace}/${p.name}${ports}${flags.length ? ` — ${flags.join(', ')}` : ''}`));
    }
    const matched = pods.filter((p) => p.etcdLike).length;
    toast(matched === pods.length
      ? `Found ${matched} etcd pod(s)`
      : `Found ${matched} etcd-like of ${pods.length} pod(s)`);
  } finally {
    btn.disabled = false;
  }
}));

$('#btn-kube-services').addEventListener('click', guard(async () => {
  const res = await call(api.kube.services, {
    ...searchOpts(),
    port: Number($('#cf-kube-port').value) || null,
  });
  if (res.services.length === 0) { toast('No etcd-like services found', 'warn'); return; }
  const scheme = $('#cf-tls').checked ? 'https' : 'http';
  $('#cf-endpoints').value = res.services.map((s) => `${scheme}://${s.dns}`).join(', ');
  toast(`Filled ${res.services.length} service endpoint(s)`);
}));

function validateProfile(p) {
  if (p.kube.enabled) {
    // Agent mode discovers endpoints when none are given; port-forward mode
    // derives them from the chosen pod. Neither needs the Endpoints field.
    if (p.kube.mode === 'portforward' && !p.kube.pod) {
      toast('Discover and choose an etcd pod first', 'warn');
      return false;
    }
    return true;
  }
  if (!p.endpoints) { toast('Endpoints are required', 'warn'); return false; }
  return true;
}

$$('[data-pick]').forEach((btn) =>
  btn.addEventListener('click', guard(async () => {
    const res = await call(api.dialog.pickFile, { title: 'Choose certificate file' });
    if (!res.canceled) $(`#${btn.dataset.pick}`).value = res.path;
  })));

$('#btn-save-profile').addEventListener('click', guard(async () => {
  const p = readForm();
  if (!validateProfile(p)) return;
  if (!p.name) p.name = p.kube.enabled ? `k8s: ${p.kube.pod}` : p.endpoints;
  if (state.selectedProfile >= 0) state.profiles[state.selectedProfile] = p;
  else { state.profiles.push(p); state.selectedProfile = state.profiles.length - 1; }
  await call(api.profiles.save, state.profiles);
  renderProfiles();
  toast(`Profile “${p.name}” saved`);
}));

$('#btn-delete-profile').addEventListener('click', guard(async () => {
  if (state.selectedProfile < 0) return;
  const p = state.profiles[state.selectedProfile];
  const yes = await confirmDialog({
    title: 'Delete profile?',
    body: `Remove the saved profile “${p.name}”. This does not touch the etcd cluster.`,
    confirmText: 'Delete profile',
  });
  if (!yes) return;
  state.profiles.splice(state.selectedProfile, 1);
  state.selectedProfile = -1;
  await call(api.profiles.save, state.profiles);
  fillForm({ endpoints: 'http://127.0.0.1:2379' });
  renderProfiles();
  toast('Profile deleted');
}));

const connect = guard(async () => {
  const p = readForm();
  if (!validateProfile(p)) return;
  const btn = $('#btn-connect');
  btn.disabled = true;
  btn.textContent = 'Connecting…';
  try {
    state.connInfo = await call(api.conn.connect, p);
    setConnected(true, p);
    toast(`Connected — etcd ${state.connInfo.version}`);
    showView('keys');
    await refreshKeys();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Connect';
  }
});

$('#conn-form').addEventListener('submit', (e) => { e.preventDefault(); connect(); });

// ---------------------------------------------------------------- keys: data

async function refreshKeys() {
  const prefix = $('#keys-prefix').value.trim();
  const data = await call(api.kv.list, { prefix, limit: 5000 });
  state.keys = data.keys;
  const truncated = data.more ? ` (showing first 5000 of ${data.count})` : '';
  $('#keys-sub').textContent = `${data.keys.length} keys · revision ${data.revision}${truncated}`;
  if (data.more) toast('Key list truncated at 5000 — narrow the prefix to see the rest', 'warn');
  renderTree();
}

$('#btn-keys-refresh').addEventListener('click', guard(refreshKeys));
$('#keys-prefix').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') guard(refreshKeys)();
});

// ---------------------------------------------------------------- keys: tree

function buildTree(keys) {
  const root = { children: new Map(), leafKey: null };
  for (const k of keys) {
    const parts = k.key.split('/');
    let node = root;
    let path = '';
    parts.forEach((part, i) => {
      path = i === 0 ? part : `${path}/${part}`;
      if (i === parts.length - 1) {
        if (!node.children.has(part)) node.children.set(part, { children: new Map(), leafKey: null, path });
        node.children.get(part).leafKey = k.key;
      } else {
        if (!node.children.has(part)) node.children.set(part, { children: new Map(), leafKey: null, path });
        node = node.children.get(part);
      }
    });
  }
  return root;
}

function countLeaves(node) {
  let n = node.leafKey ? 1 : 0;
  for (const child of node.children.values()) n += countLeaves(child);
  return n;
}

function renderTree() {
  const treeEl = $('#key-tree');
  const emptyEl = $('#tree-empty');
  treeEl.textContent = '';

  const filter = $('#keys-filter').value.trim().toLowerCase();
  let keys = state.keys;
  if (filter) keys = keys.filter((k) => k.key.toLowerCase().includes(filter));

  if (keys.length === 0) {
    emptyEl.classList.remove('hidden');
    emptyEl.textContent = state.keys.length === 0
      ? 'No keys loaded. Adjust the prefix and press Refresh, or create a key with ⌘N.'
      : 'No keys match the filter.';
    return;
  }
  emptyEl.classList.add('hidden');

  const root = buildTree(keys);
  const autoExpand = Boolean(filter);

  const renderNode = (node, name, depth) => {
    const hasChildren = node.children.size > 0;
    const isExpanded = autoExpand || state.expanded.has(node.path);
    const li = el('li', { role: 'treeitem', 'aria-selected': String(node.leafKey === state.selectedKey && !hasChildren) });
    if (hasChildren) li.setAttribute('aria-expanded', String(isExpanded));

    const label = name === '' ? '∅' : name;

    if (hasChildren) {
      const row = el('div', {
        class: 'tree-row', tabindex: '-1', dataset: { path: node.path, kind: 'folder' },
        onclick: () => { toggleExpand(node.path); },
      },
        el('span', { class: 'twisty', 'aria-hidden': 'true' }, '▶'),
        el('span', {}, label),
        el('span', { class: 'count' }, String(countLeaves(node))),
      );
      li.append(row);
      if (isExpanded) {
        const group = el('ul', { role: 'group' });
        // A key may exist AT the folder path too (e.g. both /app and /app/x).
        if (node.leafKey) group.append(renderLeaf(node.leafKey, '(value at this key)', depth + 1));
        for (const [childName, child] of [...node.children.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
          group.append(renderNode(child, childName, depth + 1));
        }
        li.append(group);
      }
      return li;
    }
    return renderLeaf(node.leafKey, label, depth);
  };

  const renderLeaf = (fullKey, label, depth) => {
    const li = el('li', { role: 'treeitem', 'aria-selected': String(fullKey === state.selectedKey) });
    const row = el('div', {
      class: `tree-row${fullKey === state.selectedKey ? ' selected' : ''}`,
      tabindex: '-1', dataset: { key: fullKey, kind: 'leaf' },
      onclick: () => selectKey(fullKey),
      title: fullKey,
    },
      el('span', { class: 'leaf-dot', 'aria-hidden': 'true' }, '●'),
      el('span', {}, label),
    );
    li.append(row);
    return li;
  };

  // Nearly all etcd keys start with '/', which would bury everything under a
  // single unnamed root folder. Flatten it: show '/app', '/infra', … directly.
  let top = [...root.children.entries()];
  if (top.length === 1 && top[0][0] === '' && top[0][1].children.size > 0) {
    const rootNode = top[0][1];
    if (rootNode.leafKey) treeEl.append(renderLeaf(rootNode.leafKey, '/', 0));
    top = [...rootNode.children.entries()].map(([name, child]) => [`/${name}`, child]);
  }
  for (const [name, child] of top.sort((a, b) => a[0].localeCompare(b[0]))) {
    treeEl.append(renderNode(child, name, 0));
  }

  // Roving tabindex: first row is tabbable.
  const rows = treeEl.querySelectorAll('.tree-row');
  if (rows.length) rows[0].tabIndex = 0;
}

function toggleExpand(path) {
  if (state.expanded.has(path)) state.expanded.delete(path);
  else state.expanded.add(path);
  renderTree();
}

// Tree keyboard navigation (roving tabindex)
$('#key-tree').addEventListener('keydown', (e) => {
  const rows = Array.from($('#key-tree').querySelectorAll('.tree-row'));
  const idx = rows.indexOf(document.activeElement);
  if (idx === -1) return;
  const row = rows[idx];
  const move = (to) => {
    if (to < 0 || to >= rows.length) return;
    rows.forEach((r) => (r.tabIndex = -1));
    rows[to].tabIndex = 0;
    rows[to].focus();
    e.preventDefault();
  };
  switch (e.key) {
    case 'ArrowDown': move(idx + 1); break;
    case 'ArrowUp': move(idx - 1); break;
    case 'ArrowRight':
      if (row.dataset.kind === 'folder' && !state.expanded.has(row.dataset.path)) { toggleExpand(row.dataset.path); e.preventDefault(); }
      else move(idx + 1);
      break;
    case 'ArrowLeft':
      if (row.dataset.kind === 'folder' && state.expanded.has(row.dataset.path)) { toggleExpand(row.dataset.path); e.preventDefault(); }
      break;
    case 'Enter': case ' ':
      if (row.dataset.kind === 'leaf') selectKey(row.dataset.key);
      else toggleExpand(row.dataset.path);
      e.preventDefault();
      break;
  }
});

let filterTimer = null;
$('#keys-filter').addEventListener('input', () => {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(renderTree, 120);
});

// -------------------------------------------------------------- keys: editor

const selectKey = guard(async (key) => {
  if (state.editor.dirty) {
    const yes = await confirmDialog({
      title: 'Discard unsaved changes?',
      body: `You have unsaved edits on ${state.selectedKey}. Switching keys will discard them.`,
      confirmText: 'Discard',
    });
    if (!yes) return;
  }
  state.selectedKey = key;
  state.editor.dirty = false;
  state.editor.loadedRev = null;
  $('#editor-rev').value = '';
  const data = await call(api.kv.get, { key });
  renderEditor(data);
  renderTree();
});

function metaChip(label, value) {
  return el('span', { class: 'badge dim' }, `${label} `, el('strong', {}, value));
}

function renderEditor(data) {
  const empty = $('#editor-empty');
  const main = $('#editor-main');
  if (!data || !data.found) {
    if (data && !data.found) toast(`Key ${data.key} no longer exists`, 'warn');
    empty.style.display = 'flex';
    main.classList.add('hidden');
    state.selectedKey = data ? null : state.selectedKey;
    return;
  }
  empty.style.display = 'none';
  main.classList.remove('hidden');

  $('#editor-key').textContent = data.key;
  const meta = $('#editor-meta');
  meta.textContent = '';
  meta.append(
    metaChip('version', data.version),
    metaChip('created @rev', data.createRevision),
    metaChip('modified @rev', data.modRevision),
    metaChip('size', fmtBytes(data.value.size)),
  );
  if (data.lease && data.lease !== '0') {
    meta.append(el('span', { class: 'badge warn' }, `lease ${shortId(data.lease)}`));
  }

  const editor = $('#value-editor');
  editor.value = data.value.text;
  state.editor.encoding = data.value.encoding;
  state.editor.dirty = false;
  $('#editor-dirty').classList.add('hidden');
  $('#editor-oldrev').classList.toggle('hidden', !state.editor.loadedRev);

  const enc = $('#editor-encoding');
  enc.textContent = data.value.encoding === 'base64' ? 'binary · shown as base64' : 'utf-8';
  enc.className = data.value.encoding === 'base64' ? 'badge warn' : 'badge dim';

  // Open a decodable value in its most readable view rather than raw bytes.
  const info = Codecs.inspect(Codecs.toBytes(data.value.text, data.value.encoding));
  const preferred = ['k8s', 'image', 'gunzip', 'pretty'].find((v) => info.views.includes(v));
  state.editor.view = preferred || 'raw';

  updateJsonState();
  refreshValueInfo();
}

function updateJsonState() {
  const out = $('#json-state');
  if (state.editor.encoding === 'base64') { out.textContent = ''; return; }
  const text = $('#value-editor').value.trim();
  if (!text || (!text.startsWith('{') && !text.startsWith('['))) { out.textContent = ''; return; }
  try { JSON.parse(text); out.textContent = 'valid JSON'; out.style.color = 'var(--accent)'; }
  catch (_) { out.textContent = 'invalid JSON'; out.style.color = 'var(--warn)'; }
}

let infoTimer = null;
$('#value-editor').addEventListener('input', () => {
  state.editor.dirty = true;
  $('#editor-dirty').classList.remove('hidden');
  updateJsonState();
  clearTimeout(infoTimer);
  infoTimer = setTimeout(refreshValueInfo, 200);
});

// ------------------------------------------------------------- value views
//
// Views are read-only renderings computed from the edit buffer. Switching
// view never writes to the textarea, so formatting a value costs nothing and
// leaves the key unmodified. "Apply to editor" is the one opt-in that does
// turn a rendering into a real (savable) edit.

const VIEW_LABELS = {
  raw: 'Raw',
  pretty: 'Pretty JSON',
  k8s: 'Kubernetes',
  gunzip: 'Decompressed',
  base64: 'Base64 decoded',
  image: 'Image',
  hex: 'Hex',
};

// Views whose text is a faithful alternative encoding of the same value and
// so may be written back to the editor.
const APPLICABLE = new Set(['pretty', 'base64', 'gunzip']);

function currentBytes() {
  return Codecs.toBytes($('#value-editor').value, state.editor.encoding);
}

/** Paint tokenized text into a node as styled spans (never as HTML). */
function paint(node, text, mode) {
  node.textContent = '';
  const frag = document.createDocumentFragment();
  for (const { t, v } of Codecs.tokenize(text, mode)) {
    if (t === 'plain') frag.append(document.createTextNode(v));
    else frag.append(el('span', { class: `tok-${t}` }, v));
  }
  node.append(frag);
}

/** Render decoded bytes: pretty JSON when it is JSON, else text, else hex. */
function paintDecoded(node, bytes) {
  const text = Codecs.tryUtf8(bytes);
  if (!Codecs.isPrintable(text)) { paint(node, Codecs.hexDump(bytes), 'hex'); return; }
  const pretty = Codecs.prettyJson(text);
  paint(node, pretty ?? text, pretty ? 'json' : null);
}

function refreshValueInfo() {
  let info;
  try {
    info = Codecs.inspect(currentBytes());
  } catch (_) {
    info = { typeName: 'unknown', views: ['raw', 'hex'], json: null };
  }
  state.editor.info = info;

  // A view can stop applying after an edit (e.g. JSON becomes invalid).
  if (!info.views.includes(state.editor.view)) state.editor.view = 'raw';

  $('#value-type').textContent = info.typeName;
  const bar = $('#view-modes');
  bar.textContent = '';
  for (const view of info.views) {
    bar.append(el('button', {
      type: 'button', role: 'tab',
      'aria-selected': String(view === state.editor.view),
      onclick: () => setView(view),
    }, VIEW_LABELS[view] || view));
  }
  renderView();
}

const setView = (view) => { state.editor.view = view; refreshValueInfo(); };

async function renderView() {
  const view = state.editor.view;
  const editor = $('#value-editor');
  const pre = $('#value-view');
  const imageBox = $('#value-image');

  const showEditor = view === 'raw';
  editor.classList.toggle('hidden', !showEditor);
  pre.classList.toggle('hidden', showEditor || view === 'image');
  imageBox.classList.toggle('hidden', view !== 'image');
  const note = $('#view-note');
  note.textContent = showEditor ? '' : 'read-only';
  note.title = showEditor ? '' : 'This is a rendering of the value — switch to Raw to edit it';
  $('#btn-apply-view').classList.toggle('hidden', !APPLICABLE.has(view));
  if (showEditor) return;

  const bytes = currentBytes();
  try {
    if (view === 'pretty') {
      const pretty = Codecs.prettyJson($('#value-editor').value);
      paint(pre, pretty ?? 'not valid JSON', pretty ? 'json' : null);
    } else if (view === 'hex') {
      paint(pre, Codecs.hexDump(bytes), 'hex');
    } else if (view === 'k8s') {
      const decoded = Codecs.decodeK8s(bytes);
      if (decoded) paint(pre, Codecs.renderK8s(decoded), 'tree');
      else paint(pre, 'not a Kubernetes protobuf value', null);
    } else if (view === 'gunzip') {
      paintDecoded(pre, await Codecs.gunzip(bytes));
    } else if (view === 'base64') {
      paintDecoded(pre, Codecs.toBytes($('#value-editor').value.trim(), 'base64'));
    } else if (view === 'image') {
      // A data: URI rather than a blob: one — the page's CSP allows data:
      // for images, and there is no object URL to release afterwards.
      $('#value-image-img').src =
        `data:${state.editor.info.mime};base64,${Codecs.bytesToBase64(bytes)}`;
    }
  } catch (err) {
    pre.textContent = `could not decode: ${err.message}`;
  }
}

$('#btn-apply-view').addEventListener('click', () => {
  const text = $('#value-view').textContent;
  if (!text) return;
  const editor = $('#value-editor');
  if (state.editor.view === 'base64' || state.editor.view === 'gunzip') {
    // The rendered text becomes the value itself, so it is stored as UTF-8.
    state.editor.encoding = 'utf8';
  }
  editor.value = text;
  state.editor.view = 'raw';
  editor.dispatchEvent(new Event('input'));
  toast('Applied to the editor — save to write it to etcd');
});

// Inline base64 transforms. Unlike views these DO edit the buffer, so they
// mark the key dirty and need an explicit save.
$('#btn-b64-decode').addEventListener('click', () => {
  const editor = $('#value-editor');
  const text = editor.value.trim();
  if (!Codecs.looksLikeBase64(text)) { toast('Value is not valid base64', 'warn'); return; }
  const bytes = Codecs.toBytes(text, 'base64');
  const decoded = Codecs.tryUtf8(bytes);
  if (!Codecs.isPrintable(decoded)) {
    toast('Decodes to binary — use the Hex view instead of editing it as text', 'warn');
    setView('hex');
    return;
  }
  editor.value = decoded;
  state.editor.encoding = 'utf8';
  state.editor.view = 'raw';
  editor.dispatchEvent(new Event('input'));
  toast('Decoded — save to write it to etcd');
});

$('#btn-b64-encode').addEventListener('click', () => {
  const editor = $('#value-editor');
  editor.value = Codecs.bytesToBase64(currentBytes());
  state.editor.encoding = 'utf8'; // the base64 text is now the stored value
  state.editor.view = 'raw';
  editor.dispatchEvent(new Event('input'));
  toast('Encoded — save to write it to etcd');
});

$('#btn-copy-key').addEventListener('click', guard(async () => {
  await navigator.clipboard.writeText(state.selectedKey);
  toast('Key copied to clipboard');
}));
$('#btn-copy-value').addEventListener('click', guard(async () => {
  await navigator.clipboard.writeText($('#value-editor').value);
  toast('Value copied to clipboard');
}));

$('#btn-load-rev').addEventListener('click', guard(async () => {
  const rev = $('#editor-rev').value.trim();
  state.editor.loadedRev = rev || null;
  const data = await call(api.kv.get, { key: state.selectedKey, revision: rev || null });
  if (!data.found) { toast(rev ? `Key did not exist at revision ${rev} (or revision was compacted)` : 'Key not found', 'warn'); return; }
  renderEditor(data);
}));

const saveKey = guard(async () => {
  if (!state.selectedKey) return;
  await call(api.kv.put, {
    key: state.selectedKey,
    value: $('#value-editor').value,
    encoding: state.editor.encoding,
  });
  toast(`Saved ${state.selectedKey}`);
  state.editor.loadedRev = null;
  $('#editor-rev').value = '';
  const data = await call(api.kv.get, { key: state.selectedKey });
  renderEditor(data);
  guard(refreshKeys)();
});
$('#btn-key-save').addEventListener('click', saveKey);

$('#btn-key-delete').addEventListener('click', guard(async () => {
  const key = state.selectedKey;
  if (!key) return;
  const yes = await confirmDialog({
    title: 'Delete key?',
    body: el('div', {}, 'This permanently deletes ', el('span', { class: 'mono-box' }, key), ' from etcd.'),
    confirmText: 'Delete key',
  });
  if (!yes) return;
  await call(api.kv.del, { key });
  toast(`Deleted ${key}`);
  state.selectedKey = null;
  state.editor.dirty = false;
  renderEditor(null);
  await refreshKeys();
}));

// new key dialog
function openNewKey() {
  const prefix = $('#keys-prefix').value.trim();
  $('#nk-key').value = prefix;
  $('#nk-value').value = '';
  $('#nk-ttl').value = '';
  $('#dlg-newkey').showModal();
  $('#nk-key').focus();
}
$('#btn-new-key').addEventListener('click', openNewKey);

$('#btn-newkey-create').addEventListener('click', guard(async () => {
  const key = $('#nk-key').value.trim();
  if (!key) { toast('Key is required', 'warn'); return; }
  const ttl = $('#nk-ttl').value.trim();
  let leaseId = null;
  if (ttl) {
    const lease = await call(api.lease.grant, { ttl: Number(ttl) });
    leaseId = lease.id;
  }
  await call(api.kv.put, { key, value: $('#nk-value').value, encoding: 'utf8', leaseId });
  $('#dlg-newkey').close();
  toast(`Created ${key}${leaseId ? ` (lease ${shortId(leaseId)}, ${ttl}s TTL)` : ''}`);
  await refreshKeys();
  state.editor.dirty = false;
  selectKey(key);
}));

$('#btn-del-prefix').addEventListener('click', guard(async () => {
  const prefix = $('#keys-prefix').value.trim() || $('#keys-filter').value.trim();
  const input = el('input', {
    type: 'text', class: 'mono', style: 'width:100%;margin-top:8px',
    value: prefix, 'aria-label': 'Prefix to delete',
  });
  const yes = await confirmDialog({
    title: 'Delete every key under a prefix?',
    body: el('div', {},
      el('div', {}, 'All keys whose name starts with this prefix will be permanently deleted:'),
      input),
    confirmText: 'Delete all matching keys',
    typeToConfirm: 'DELETE',
  });
  if (!yes) return;
  const target = input.value.trim();
  if (!target) { toast('Prefix cannot be empty', 'warn'); return; }
  const res = await call(api.kv.delPrefix, { prefix: target });
  toast(`Deleted ${res.deleted} key(s) under ${target}`);
  state.selectedKey = null;
  renderEditor(null);
  await refreshKeys();
}));

// --------------------------------------------------------------------- watch

api.watch.onEvent((event) => {
  if (event.type === 'error') { toast(`Watch error: ${event.message}`, 'error'); return; }
  $('#watch-empty').classList.add('hidden');
  const feed = $('#watch-feed');
  const badge = event.type === 'put'
    ? el('span', { class: 'badge ok' }, 'PUT')
    : el('span', { class: 'badge bad' }, 'DEL');
  const valueLine = el('div', { class: 'w-val' });
  if (event.type === 'put') {
    if (event.prevValue && event.prevValue.text !== '') {
      valueLine.append(trunc(event.prevValue.text), el('span', { class: 'arrow' }, '  →  '), trunc(event.value.text));
    } else {
      valueLine.append(trunc(event.value.text));
    }
  } else if (event.prevValue) {
    valueLine.append(el('span', { class: 'arrow' }, 'was  '), trunc(event.prevValue.text));
  }
  feed.prepend(el('div', { class: 'watch-row' },
    el('span', { class: 'time' }, fmtTime(event.at)),
    badge,
    el('div', {},
      el('div', { class: 'w-key' }, event.key),
      valueLine),
  ));
  while (feed.children.length > 500) feed.lastChild.remove();
});

const trunc = (s, n = 160) => (s.length > n ? `${s.slice(0, n)}…` : s);

$('#btn-watch-toggle').addEventListener('click', guard(async () => {
  const btn = $('#btn-watch-toggle');
  if (state.watching) {
    await call(api.watch.stop, { id: 'main' });
    state.watching = false;
    btn.textContent = 'Start watch';
    btn.classList.add('primary');
    toast('Watch stopped');
    return;
  }
  const target = $('#watch-target').value.trim();
  if (!target) { toast('Enter a key or prefix to watch', 'warn'); return; }
  await call(api.watch.start, { id: 'main', target, isPrefix: $('#watch-prefix').checked });
  state.watching = true;
  btn.textContent = 'Stop watch';
  btn.classList.remove('primary');
  toast(`Watching ${target}`);
}));

$('#btn-watch-clear').addEventListener('click', () => {
  $('#watch-feed').textContent = '';
  $('#watch-empty').classList.remove('hidden');
});

// -------------------------------------------------------------------- leases

const LEASE_KEY_PREVIEW = 4;

/**
 * A single lease can hold thousands of keys — Kubernetes attaches every
 * event to one — which would bury the rest of the table. Show a few and
 * expand on request.
 */
function leaseKeysCell(keys) {
  if (keys.length === 0) return el('span', { class: 'dim' }, '(none)');
  const cell = el('div', { class: 'lease-keys' });
  const render = (expanded) => {
    cell.textContent = '';
    const shown = expanded ? keys : keys.slice(0, LEASE_KEY_PREVIEW);
    for (const k of shown) cell.append(el('div', { class: 'lease-key' }, k));
    if (keys.length > LEASE_KEY_PREVIEW) {
      cell.append(el('button', {
        class: 'btn small ghost', style: 'margin-top:4px',
        onclick: () => render(!expanded),
      }, expanded ? 'show fewer' : `show all ${keys.length}`));
    }
  };
  render(false);
  return cell;
}

async function refreshLeases() {
  const data = await call(api.lease.list);
  const rows = $('#lease-rows');
  rows.textContent = '';
  $('#lease-empty').classList.toggle('hidden', data.leases.length > 0);
  for (const lease of data.leases) {
    rows.append(el('tr', {},
      el('td', {}, shortId(lease.id)),
      el('td', {}, lease.ttl === '-1' ? 'expired' : `${lease.ttl}s`),
      el('td', {}, `${lease.grantedTtl}s`),
      el('td', {}, leaseKeysCell(lease.keys)),
      el('td', { class: 'actions-cell' },
        el('button', {
          class: 'btn small danger',
          onclick: guard(async () => {
            const yes = await confirmDialog({
              title: 'Revoke lease?',
              body: lease.keys.length
                ? el('div', {}, `Revoking lease ${shortId(lease.id)} immediately deletes its ${lease.keys.length} attached key(s):`, el('div', { class: 'mono-box' }, lease.keys.join('\n')))
                : `Revoke lease ${shortId(lease.id)}? It has no attached keys.`,
              confirmText: 'Revoke lease',
            });
            if (!yes) return;
            await call(api.lease.revoke, { id: lease.id });
            toast(`Lease ${shortId(lease.id)} revoked`);
            await refreshLeases();
          }),
        }, 'Revoke')),
    ));
  }
}

$('#btn-lease-refresh').addEventListener('click', guard(refreshLeases));
$('#btn-lease-grant').addEventListener('click', guard(async () => {
  const ttl = Number($('#lease-ttl').value);
  if (!ttl || ttl < 1) { toast('Enter a TTL in seconds', 'warn'); return; }
  const lease = await call(api.lease.grant, { ttl });
  toast(`Lease ${shortId(lease.id)} granted for ${lease.ttl}s`);
  $('#lease-ttl').value = '';
  await refreshLeases();
}));

// ------------------------------------------------------------------- cluster

async function refreshCluster() {
  const [data, alarms] = await Promise.all([
    call(api.cluster.overview),
    call(api.cluster.alarms),
  ]);
  $('#cluster-sub').textContent = `${data.members.length} member(s)`;

  const grid = $('#member-grid');
  grid.textContent = '';
  for (const m of data.members) {
    const card = el('div', { class: 'panel member-card' });
    const head = el('div', { class: 'm-head' },
      el('span', { class: 'm-name' }, m.name));
    if (m.status && m.status.isLeader) head.append(el('span', { class: 'badge ok' }, 'LEADER'));
    if (m.isLearner) head.append(el('span', { class: 'badge info' }, 'LEARNER'));
    if (m.statusError) head.append(el('span', { class: 'badge bad' }, 'UNREACHABLE'));
    card.append(head);

    const dl = el('dl', {});
    const add = (label, value) => dl.append(el('dt', {}, label), el('dd', {}, value));
    add('member id', shortId(m.id));
    add('client', m.clientURLs.join(', ') || '—');
    add('peer', m.peerURLs.join(', ') || '—');
    if (m.status) {
      add('version', m.status.version);
      add('db size', `${fmtBytes(m.status.dbSize)} (${fmtBytes(m.status.dbSizeInUse)} in use)`);
      add('raft term', m.status.raftTerm);
      if (m.status.errors.length) add('errors', m.status.errors.join('; '));
    } else if (m.statusError) {
      add('status', m.statusError);
    }
    card.append(dl);

    if (m.status && !m.status.isLeader && data.members.length > 1) {
      card.append(el('div', { style: 'margin-top:10px' },
        el('button', {
          class: 'btn small',
          onclick: guard(async () => {
            const yes = await confirmDialog({
              title: 'Transfer leadership?',
              body: `Move cluster leadership to member “${m.name}” (${shortId(m.id)}). Brief write pause while the transfer happens.`,
              confirmText: 'Move leader',
            });
            if (!yes) return;
            await call(api.cluster.moveLeader, { targetId: m.id });
            toast(`Leadership moved to ${m.name}`);
            await refreshCluster();
          }),
        }, 'Make leader')));
    }
    grid.append(card);
  }

  const alarmBox = $('#alarm-list');
  alarmBox.textContent = '';
  if (alarms.alarms.length === 0) {
    alarmBox.append(el('span', { class: 'badge ok' }, 'no active alarms'));
  } else {
    for (const a of alarms.alarms) {
      alarmBox.append(el('div', { class: 'row', style: 'margin-bottom:8px' },
        el('span', { class: 'badge bad' }, a.alarm),
        el('span', { class: 'mono dim' }, `member ${shortId(a.memberId)}`),
        el('button', {
          class: 'btn small',
          onclick: guard(async () => {
            await call(api.cluster.disarm, { memberId: a.memberId, alarm: a.alarm });
            toast('Alarm disarmed');
            await refreshCluster();
          }),
        }, 'Disarm')));
    }
  }
}

$('#btn-cluster-refresh').addEventListener('click', guard(refreshCluster));

// --------------------------------------------------------------- maintenance

async function refreshMaint() {
  const s = await call(api.maint.status);
  const grid = $('#maint-stats');
  grid.textContent = '';
  const tile = (label, value, plain = false) =>
    el('div', { class: 'stat-tile' },
      el('div', { class: 'micro' }, label),
      el('div', { class: `v${plain ? ' plain' : ''}` }, value));
  grid.append(
    tile('etcd version', s.version, true),
    tile('db size', fmtBytes(s.dbSize)),
    tile('in use', fmtBytes(s.dbSizeInUse)),
    tile('revision', s.revision, true),
    tile('raft term', s.raftTerm, true),
  );
  if (s.errors.length) {
    grid.append(tile('errors', s.errors.join('; '), true));
  }
}

$('#btn-maint-refresh').addEventListener('click', guard(refreshMaint));

api.maint.onSnapshotProgress((p) => {
  $('#snapshot-progress').textContent = `writing… ${fmtBytes(p.written)}`;
});

$('#btn-snapshot').addEventListener('click', guard(async () => {
  const progress = $('#snapshot-progress');
  progress.textContent = 'choose a destination…';
  const res = await call(api.maint.snapshot);
  if (res.canceled) { progress.textContent = ''; return; }
  progress.textContent = `saved ${fmtBytes(res.bytes)}`;
  toast(`Snapshot saved to ${res.path}`);
  await call(api.maint.revealFile, { filePath: res.path });
}));

$('#btn-compact').addEventListener('click', guard(async () => {
  const rev = $('#compact-rev').value.trim();
  const yes = await confirmDialog({
    title: 'Compact key history?',
    body: rev
      ? `History older than revision ${rev} will be discarded. Reads at older revisions will fail afterwards.`
      : 'History older than the current revision will be discarded. Reads at older revisions will fail afterwards.',
    confirmText: 'Compact',
  });
  if (!yes) return;
  const res = await call(api.maint.compact, { revision: rev || null });
  toast(`Compacted to revision ${res.revision}`);
  $('#compact-rev').value = '';
  await refreshMaint();
}));

$('#btn-defrag').addEventListener('click', guard(async () => {
  const yes = await confirmDialog({
    title: 'Defragment member?',
    body: 'Defragmentation rebuilds the backend database on the connected member and blocks reads and writes on it while running. Run during a quiet period.',
    confirmText: 'Defragment',
  });
  if (!yes) return;
  toast('Defragmenting…');
  await call(api.maint.defrag);
  toast('Defragmentation complete');
  await refreshMaint();
}));

// ---------------------------------------------------------------------- auth

async function refreshAuth() {
  const data = await call(api.auth.overview);
  $('#auth-sub').textContent = data.enabled === null
    ? 'authentication status unknown'
    : `authentication ${data.enabled ? 'ENABLED' : 'disabled'}`;

  const roleNames = data.roles.map((r) => r.name);

  const userRows = $('#user-rows');
  userRows.textContent = '';
  if (data.users.length === 0) {
    userRows.append(el('tr', {}, el('td', { colspan: '3', class: 'dim' }, 'No users defined.')));
  }
  for (const u of data.users) {
    const roleCell = el('td', {});
    if (u.roles.length === 0) roleCell.append(el('span', { class: 'dim' }, '(none)'));
    u.roles.forEach((r) => {
      roleCell.append(el('span', { class: 'badge info', style: 'margin:1px 3px 1px 0' }, r,
        el('button', {
          class: 'btn small ghost', style: 'min-height:0;padding:0 3px;margin-left:2px',
          'aria-label': `Revoke role ${r} from ${u.name}`, title: 'Revoke role',
          onclick: guard(async () => {
            await call(api.auth.userRevokeRole, { name: u.name, role: r });
            toast(`Revoked ${r} from ${u.name}`);
            await refreshAuth();
          }),
        }, '×')));
    });

    const grantSel = el('select', { 'aria-label': `Grant role to ${u.name}`, style: 'min-height:25px;padding:2px 6px;font-size:12px' },
      el('option', { value: '' }, 'grant role…'),
      roleNames.filter((r) => !u.roles.includes(r)).map((r) => el('option', { value: r }, r)));
    grantSel.addEventListener('change', guard(async () => {
      if (!grantSel.value) return;
      await call(api.auth.userGrantRole, { name: u.name, role: grantSel.value });
      toast(`Granted ${grantSel.value} to ${u.name}`);
      await refreshAuth();
    }));

    userRows.append(el('tr', {},
      el('td', {}, u.name),
      roleCell,
      el('td', { class: 'actions-cell' },
        grantSel, ' ',
        el('button', {
          class: 'btn small danger',
          onclick: guard(async () => {
            const yes = await confirmDialog({
              title: 'Delete user?',
              body: `Delete etcd user “${u.name}”.`,
              confirmText: 'Delete user',
            });
            if (!yes) return;
            await call(api.auth.userDelete, { name: u.name });
            toast(`User ${u.name} deleted`);
            await refreshAuth();
          }),
        }, 'Delete')),
    ));
  }

  const roleRows = $('#role-rows');
  roleRows.textContent = '';
  if (data.roles.length === 0) {
    roleRows.append(el('tr', {}, el('td', { colspan: '3', class: 'dim' }, 'No roles defined.')));
  }
  for (const r of data.roles) {
    const permCell = el('td', {});
    if (r.permissions.length === 0) permCell.append(el('span', { class: 'dim' }, '(none)'));
    r.permissions.forEach((p) => {
      const isPrefix = p.rangeEnd !== '';
      permCell.append(el('div', { class: 'row', style: 'margin:2px 0;gap:6px' },
        el('span', { class: 'badge dim' }, String(p.permission).toLowerCase()),
        el('span', {}, p.key + (isPrefix ? '…' : '')),
        el('button', {
          class: 'btn small ghost', style: 'min-height:0;padding:0 4px',
          'aria-label': `Revoke permission on ${p.key}`, title: 'Revoke permission',
          onclick: guard(async () => {
            await call(api.auth.roleRevokePermission, { name: r.name, key: p.key, prefix: isPrefix });
            toast(`Revoked ${p.key} from ${r.name}`);
            await refreshAuth();
          }),
        }, '×')));
    });

    roleRows.append(el('tr', {},
      el('td', {}, r.name),
      permCell,
      el('td', { class: 'actions-cell' },
        el('button', {
          class: 'btn small',
          onclick: () => {
            $('#gp-role').textContent = r.name;
            $('#gp-key').value = '';
            $('#dlg-grant-perm').showModal();
            $('#gp-key').focus();
          },
        }, 'Grant…'), ' ',
        el('button', {
          class: 'btn small danger',
          onclick: guard(async () => {
            const yes = await confirmDialog({
              title: 'Delete role?',
              body: `Delete role “${r.name}”. Users holding it lose its permissions.`,
              confirmText: 'Delete role',
            });
            if (!yes) return;
            await call(api.auth.roleDelete, { name: r.name });
            toast(`Role ${r.name} deleted`);
            await refreshAuth();
          }),
        }, 'Delete')),
    ));
  }
}

$('#btn-auth-refresh').addEventListener('click', guard(refreshAuth));

$('#user-add-form').addEventListener('submit', guard(async (e) => {
  e.preventDefault();
  const name = $('#ua-name').value.trim();
  const password = $('#ua-pass').value;
  if (!name || !password) { toast('Username and password are required', 'warn'); return; }
  await call(api.auth.userAdd, { name, password });
  $('#ua-name').value = ''; $('#ua-pass').value = '';
  toast(`User ${name} created`);
  await refreshAuth();
}));

$('#role-add-form').addEventListener('submit', guard(async (e) => {
  e.preventDefault();
  const name = $('#ra-name').value.trim();
  if (!name) { toast('Role name is required', 'warn'); return; }
  await call(api.auth.roleAdd, { name });
  $('#ra-name').value = '';
  toast(`Role ${name} created`);
  await refreshAuth();
}));

$('#btn-grant-perm-ok').addEventListener('click', guard(async () => {
  const name = $('#gp-role').textContent;
  const key = $('#gp-key').value.trim();
  if (!key) { toast('Key or prefix is required', 'warn'); return; }
  await call(api.auth.roleGrantPermission, {
    name, key,
    prefix: $('#gp-prefix').checked,
    permission: $('#gp-perm').value,
  });
  $('#dlg-grant-perm').close();
  toast(`Granted ${$('#gp-perm').value} on ${key} to ${name}`);
  await refreshAuth();
}));

// ----------------------------------------------------------------- shortcuts

$('#btn-help').addEventListener('click', () => $('#dlg-help').showModal());

document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);

  if (e.key === '?' && !inField) { $('#dlg-help').showModal(); e.preventDefault(); return; }
  if (!mod) return;

  const viewKeys = { 1: 'keys', 2: 'watch', 3: 'leases', 4: 'cluster', 5: 'maint', 6: 'auth', 7: 'connect' };
  if (viewKeys[e.key]) {
    if (state.connected || viewKeys[e.key] === 'connect') { showView(viewKeys[e.key]); e.preventDefault(); }
    return;
  }
  switch (e.key.toLowerCase()) {
    case 'k':
      if (state.view === 'keys') { $('#keys-filter').focus(); $('#keys-filter').select(); e.preventDefault(); }
      break;
    case 'n':
      if (state.view === 'keys' && state.connected) { openNewKey(); e.preventDefault(); }
      break;
    case 's':
      if (state.view === 'keys' && state.selectedKey) { saveKey(); e.preventDefault(); }
      break;
    case 'r': {
      e.preventDefault();
      const refreshers = { keys: refreshKeys, leases: refreshLeases, cluster: refreshCluster, maint: refreshMaint, auth: refreshAuth };
      if (state.connected && refreshers[state.view]) guard(refreshers[state.view])();
      break;
    }
  }
});

// ---------------------------------------------------------------------- boot

(async function boot() {
  try {
    state.profiles = await call(api.profiles.list);
  } catch (err) {
    toast(`Could not load profiles: ${err.message}`, 'error');
  }
  renderProfiles();
  if (state.profiles.length > 0) {
    state.selectedProfile = 0;
    fillForm(state.profiles[0]);
    renderProfiles();
  } else {
    fillForm({ endpoints: 'http://127.0.0.1:2379' });
  }
  $('#pw-storage-hint').textContent =
    'Passwords in saved profiles are encrypted with your OS keychain when available.';
})();
