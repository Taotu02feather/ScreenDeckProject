'use strict';

/**
 * 大屏输出窗口的 preload。
 * 权限比控制台更小：只能读状态、渲染、上报页数。
 */

const { contextBridge, ipcRenderer } = require('electron');

function onState(callback) {
  const listener = (_event, snapshot) => callback(snapshot);
  ipcRenderer.on('state:event', listener);
  return () => ipcRenderer.removeListener('state:event', listener);
}

contextBridge.exposeInMainWorld('screenDeck', {
  getState: () => ipcRenderer.invoke('state:get'),
  patch: (partial) => ipcRenderer.invoke('state:patch', partial),
  onState,
  loadDocument: (id) => ipcRenderer.invoke('doc:load', id),
  // 上报真实视口尺寸：映射窗按它布局，保证两边取景一致
  reportViewport: (size) => ipcRenderer.invoke('output:viewport', size),
});
