const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('granuPose', {
  versions: {
    chrome: process.versions.chrome,
    electron: process.versions.electron,
    node: process.versions.node,
  },
  osc: {
    configure: (payload = {}) => ipcRenderer.invoke('granuPose:osc:configure', payload),
    getStatus: () => ipcRenderer.invoke('granuPose:osc:status'),
    sendChannel: (payload) => ipcRenderer.invoke('granuPose:osc:sendChannel', payload),
    sendMessage: (payload) => ipcRenderer.invoke('granuPose:osc:sendMessage', payload),
  },
  telemetry: {
    getStatus: () => ipcRenderer.invoke('granuPose:telemetry:status'),
    subscribeHello: (listener) => {
      if (typeof listener !== 'function') {
        return () => {};
      }

      const channel = 'granuPose:telemetry:hello';
      const wrapped = (_event, payload) => listener(payload);
      ipcRenderer.on(channel, wrapped);
      return () => {
        ipcRenderer.removeListener(channel, wrapped);
      };
    },
    subscribeScan: (listener) => {
      if (typeof listener !== 'function') {
        return () => {};
      }

      const channel = 'granuPose:telemetry:scan';
      const wrapped = (_event, payload) => listener(payload);
      ipcRenderer.on(channel, wrapped);
      return () => {
        ipcRenderer.removeListener(channel, wrapped);
      };
    },
  },
  engine: {
    start: () => ipcRenderer.invoke('granuPose:engine:start'),
    stop: () => ipcRenderer.invoke('granuPose:engine:stop'),
    restart: () => ipcRenderer.invoke('granuPose:engine:restart'),
    getStatus: () => ipcRenderer.invoke('granuPose:engine:status'),
    getLogs: (payload = {}) => ipcRenderer.invoke('granuPose:engine:getLogs', payload),
    subscribeStatus: (listener) => {
      if (typeof listener !== 'function') {
        return () => {};
      }

      const channel = 'granuPose:engine:status';
      const wrapped = (_event, payload) => listener(payload);
      ipcRenderer.on(channel, wrapped);
      return () => {
        ipcRenderer.removeListener(channel, wrapped);
      };
    },
    subscribeLogs: (listener) => {
      if (typeof listener !== 'function') {
        return () => {};
      }

      const channel = 'granuPose:engine:log';
      const wrapped = (_event, payload) => listener(payload);
      ipcRenderer.on(channel, wrapped);
      return () => {
        ipcRenderer.removeListener(channel, wrapped);
      };
    },
  },
  midi: {
    configure: (payload = {}) => ipcRenderer.invoke('granuPose:midi:configure', payload),
    getStatus: () => ipcRenderer.invoke('granuPose:midi:status'),
    listOutputs: () => ipcRenderer.invoke('granuPose:midi:listOutputs'),
    sendChannel: (payload) => ipcRenderer.invoke('granuPose:midi:sendChannel', payload),
  },
  audio: {
    listOutputs: () => ipcRenderer.invoke('granuPose:audio:listOutputs'),
    listRecordings: (payload = {}) =>
      ipcRenderer.invoke('granuPose:audio:listRecordings', payload),
    readRecordingAsBase64: (payload = {}) =>
      ipcRenderer.invoke('granuPose:audio:readRecordingAsBase64', payload),
  },
  dialog: {
    pickWavFile: (payload = {}) => ipcRenderer.invoke('granuPose:dialog:pickWavFile', payload),
    readWavFileAsBase64: (payload) =>
      ipcRenderer.invoke('granuPose:dialog:readWavFileAsBase64', payload),
    getDefaultStaticWavPath: () => ipcRenderer.invoke('granuPose:dialog:getDefaultStaticWavPath'),
    pickDirectory: () => ipcRenderer.invoke('granuPose:dialog:pickDirectory'),
  },
});
