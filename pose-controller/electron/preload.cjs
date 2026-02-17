const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('granuPose', {
  versions: {
    chrome: process.versions.chrome,
    electron: process.versions.electron,
    node: process.versions.node,
  },
});
