'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, dialog, safeStorage, shell } = require('electron');
const { EtcdService } = require('./lib/etcd-service');
const kube = require('./lib/kube-bridge');
const agentManager = require('./lib/agent-manager');
const { fetchEtcdCerts } = require('./lib/cert-fetcher');

const service = new EtcdService();
let mainWindow = null;

// ------------------------------------------------------------------ profiles

const profilesPath = () => path.join(app.getPath('userData'), 'profiles.json');

function loadProfiles() {
  try {
    const raw = JSON.parse(fs.readFileSync(profilesPath(), 'utf8'));
    return raw.map((p) => {
      const profile = { ...p };
      if (p.encryptedPassword && safeStorage.isEncryptionAvailable()) {
        try {
          profile.password = safeStorage.decryptString(Buffer.from(p.encryptedPassword, 'base64'));
        } catch (_) {
          profile.password = '';
        }
      }
      delete profile.encryptedPassword;
      return profile;
    });
  } catch (_) {
    return [];
  }
}

function saveProfiles(profiles) {
  const toStore = profiles.map((p) => {
    const profile = { ...p };
    if (profile.password) {
      if (safeStorage.isEncryptionAvailable()) {
        profile.encryptedPassword = safeStorage.encryptString(profile.password).toString('base64');
        delete profile.password;
      }
      // If OS encryption is unavailable the password stays in plain text;
      // the renderer warns the user about this in the connection form.
    }
    return profile;
  });
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(profilesPath(), JSON.stringify(toStore, null, 2));
}

// ----------------------------------------------------------------------- ipc

function wrap(fn) {
  return async (_event, args) => {
    try {
      const result = await fn(args);
      return { ok: true, data: result };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  };
}

ipcMain.handle('profiles:list', wrap(async () => loadProfiles()));
ipcMain.handle('profiles:save', wrap(async (profiles) => { saveProfiles(profiles); return { ok: true }; }));

ipcMain.handle('conn:connect', wrap((profile) => service.connect(profile)));
ipcMain.handle('conn:disconnect', wrap(() => service.disconnect()));

ipcMain.handle('kv:list', wrap((a) => service.listKeys(a)));
ipcMain.handle('kv:get', wrap((a) => service.getKey(a)));
ipcMain.handle('kv:put', wrap((a) => service.putKey(a)));
ipcMain.handle('kv:del', wrap((a) => service.deleteKey(a)));
ipcMain.handle('kv:delPrefix', wrap((a) => service.deletePrefix(a)));

ipcMain.handle('watch:start', wrap((a) =>
  service.startWatch(a, (event) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('watch:event', event);
    }
  })
));
ipcMain.handle('watch:stop', wrap((a) => service.stopWatch(a)));

ipcMain.handle('lease:grant', wrap((a) => service.grantLease(a)));
ipcMain.handle('lease:list', wrap(() => service.listLeases()));
ipcMain.handle('lease:revoke', wrap((a) => service.revokeLease(a)));

ipcMain.handle('cluster:overview', wrap(() => service.clusterOverview()));
ipcMain.handle('cluster:alarms', wrap(() => service.listAlarms()));
ipcMain.handle('cluster:disarm', wrap((a) => service.disarmAlarm(a)));
ipcMain.handle('cluster:moveLeader', wrap((a) => service.moveLeader(a)));

ipcMain.handle('maint:status', wrap(() => service.status()));
ipcMain.handle('maint:defrag', wrap(() => service.defragment()));
ipcMain.handle('maint:compact', wrap((a) => service.compact(a)));
ipcMain.handle('maint:snapshot', wrap(async () => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Save etcd snapshot',
    defaultPath: `etcd-snapshot-${new Date().toISOString().replace(/[:.]/g, '-')}.db`,
    filters: [{ name: 'etcd snapshot', extensions: ['db'] }],
  });
  if (canceled || !filePath) return { canceled: true };
  return service.snapshot({ filePath }, (progress) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('snapshot:progress', progress);
    }
  });
}));
ipcMain.handle('maint:revealFile', wrap(async ({ filePath }) => {
  shell.showItemInFolder(filePath);
  return { ok: true };
}));

ipcMain.handle('auth:overview', wrap(() => service.authOverview()));
ipcMain.handle('auth:userAdd', wrap((a) => service.userAdd(a)));
ipcMain.handle('auth:userDelete', wrap((a) => service.userDelete(a)));
ipcMain.handle('auth:userGrantRole', wrap((a) => service.userGrantRole(a)));
ipcMain.handle('auth:userRevokeRole', wrap((a) => service.userRevokeRole(a)));
ipcMain.handle('auth:roleAdd', wrap((a) => service.roleAdd(a)));
ipcMain.handle('auth:roleDelete', wrap((a) => service.roleDelete(a)));
ipcMain.handle('auth:roleGrantPermission', wrap((a) => service.roleGrantPermission(a)));
ipcMain.handle('auth:roleRevokePermission', wrap((a) => service.roleRevokePermission(a)));

ipcMain.handle('kube:contexts', wrap((a) => kube.listContexts(a)));
ipcMain.handle('kube:discover', wrap((a) => kube.discoverPods(a)));
ipcMain.handle('kube:defaultPath', wrap(async () => ({ path: kube.DEFAULT_KUBECONFIG })));

ipcMain.handle('kube:namespaces', wrap((a) => kube.listNamespaces(a)));
ipcMain.handle('kube:services', wrap((a) => kube.discoverServices(a)));
ipcMain.handle('kube:endpoints', wrap((a) => kube.discoverEndpoints(a).then((endpoints) => ({ endpoints }))));
ipcMain.handle('kube:fetchCerts', wrap((a) =>
  fetchEtcdCerts({ ...a, outDir: path.join(app.getPath('userData'), 'certs') })));

ipcMain.handle('agent:ensure', wrap((a) => agentManager.ensureAgent(a)));
ipcMain.handle('agent:status', wrap((a) => agentManager.agentStatus(a)));
ipcMain.handle('agent:remove', wrap((a) => agentManager.removeAgent(a)));

ipcMain.handle('dialog:pickFile', wrap(async ({ title }) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: title || 'Choose file',
    properties: ['openFile', 'showHiddenFiles'],
  });
  if (canceled || filePaths.length === 0) return { canceled: true };
  return { path: filePaths[0] };
}));

// -------------------------------------------------------------------- window

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 940,
    minHeight: 620,
    title: 'etcdee',
    backgroundColor: '#0b0f14',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  service.disconnect().finally(() => {
    if (process.platform !== 'darwin') app.quit();
  });
});

app.on('before-quit', () => {
  service.disconnect().catch(() => {});
});
