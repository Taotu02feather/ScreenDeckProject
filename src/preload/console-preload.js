'use strict';

/**
 * 控制台窗口的 preload。
 * 只暴露白名单方法；渲染层拿不到 ipcRenderer，也拿不到 require。
 */

const { contextBridge, ipcRenderer } = require('electron');

function onState(callback) {
  const listener = (_event, snapshot) => callback(snapshot);
  ipcRenderer.on('state:event', listener);
  return () => ipcRenderer.removeListener('state:event', listener);
}

function onViewport(callback) {
  const listener = (_event, size) => callback(size);
  ipcRenderer.on('viewport:changed', listener);
  return () => ipcRenderer.removeListener('viewport:changed', listener);
}

contextBridge.exposeInMainWorld('screenDeck', {
  // 共享状态
  getState: () => ipcRenderer.invoke('state:get'),
  patch: (partial) => ipcRenderer.invoke('state:patch', partial),
  onState,
  onViewport,

  // 内部内容源
  loadDocument: (id) => ipcRenderer.invoke('doc:load', id),
  listDocuments: () => ipcRenderer.invoke('docs:list'),
  openDocuments: () => ipcRenderer.invoke('docs:open'),
  selectDocument: (id) => ipcRenderer.invoke('docs:select', id),
  removeDocument: (id) => ipcRenderer.invoke('docs:remove', id),

  // 外部窗口源
  listWindows: () => ipcRenderer.invoke('windows:list'),
  selectWindow: (payload) => ipcRenderer.invoke('windows:select', payload),
  captureInfo: () => ipcRenderer.invoke('capture:info'),

  // 显示器 / 布局 / 偏好
  listDisplays: () => ipcRenderer.invoke('display:list'),
  getLayout: () => ipcRenderer.invoke('layout:get'),
  setLayout: (partial) => ipcRenderer.invoke('layout:set', partial),
  getPrefs: () => ipcRenderer.invoke('prefs:get'),
  setPrefs: (partial) => ipcRenderer.invoke('prefs:set', partial),

  // 输出窗口控制
  toggleOutput: () => ipcRenderer.invoke('output:toggle'),
  outputSize: () => ipcRenderer.invoke('output:size'),

  // 事件注入（实验，外部窗口源时可用）
  injectStatus: () => ipcRenderer.invoke('inject:status'),
  injectClick: (payload) => ipcRenderer.invoke('inject:click', payload),
  injectWheel: (payload) => ipcRenderer.invoke('inject:wheel', payload),
  injectDisable: () => ipcRenderer.invoke('inject:disable'),
  injectEnable: () => ipcRenderer.invoke('inject:enable'),

  quit: () => ipcRenderer.invoke('app:quit'),
});
