'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (args) => ipcRenderer.invoke(channel, args);

contextBridge.exposeInMainWorld('etcdee', {
  profiles: {
    list: invoke('profiles:list'),
    save: invoke('profiles:save'),
  },
  conn: {
    connect: invoke('conn:connect'),
    disconnect: invoke('conn:disconnect'),
  },
  kv: {
    list: invoke('kv:list'),
    get: invoke('kv:get'),
    put: invoke('kv:put'),
    del: invoke('kv:del'),
    delPrefix: invoke('kv:delPrefix'),
  },
  watch: {
    start: invoke('watch:start'),
    stop: invoke('watch:stop'),
    onEvent: (handler) => {
      const listener = (_e, event) => handler(event);
      ipcRenderer.on('watch:event', listener);
      return () => ipcRenderer.removeListener('watch:event', listener);
    },
  },
  lease: {
    grant: invoke('lease:grant'),
    list: invoke('lease:list'),
    revoke: invoke('lease:revoke'),
  },
  cluster: {
    overview: invoke('cluster:overview'),
    alarms: invoke('cluster:alarms'),
    disarm: invoke('cluster:disarm'),
    moveLeader: invoke('cluster:moveLeader'),
  },
  maint: {
    status: invoke('maint:status'),
    defrag: invoke('maint:defrag'),
    compact: invoke('maint:compact'),
    snapshot: invoke('maint:snapshot'),
    revealFile: invoke('maint:revealFile'),
    onSnapshotProgress: (handler) => {
      const listener = (_e, progress) => handler(progress);
      ipcRenderer.on('snapshot:progress', listener);
      return () => ipcRenderer.removeListener('snapshot:progress', listener);
    },
  },
  auth: {
    overview: invoke('auth:overview'),
    userAdd: invoke('auth:userAdd'),
    userDelete: invoke('auth:userDelete'),
    userGrantRole: invoke('auth:userGrantRole'),
    userRevokeRole: invoke('auth:userRevokeRole'),
    roleAdd: invoke('auth:roleAdd'),
    roleDelete: invoke('auth:roleDelete'),
    roleGrantPermission: invoke('auth:roleGrantPermission'),
    roleRevokePermission: invoke('auth:roleRevokePermission'),
  },
  kube: {
    contexts: invoke('kube:contexts'),
    discover: invoke('kube:discover'),
    defaultPath: invoke('kube:defaultPath'),
    endpoints: invoke('kube:endpoints'),
    fetchCerts: invoke('kube:fetchCerts'),
  },
  agent: {
    ensure: invoke('agent:ensure'),
    status: invoke('agent:status'),
    remove: invoke('agent:remove'),
  },
  dialog: {
    pickFile: invoke('dialog:pickFile'),
  },
});
