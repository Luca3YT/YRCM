'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// レンダラー（admin.html）からメインプロセスへの安全な橋渡し
contextBridge.exposeInMainWorld('electronAPI', {
  // ウィンドウ操作
  minimize  : () => ipcRenderer.send('window-minimize'),
  hide      : () => ipcRenderer.send('window-hide'),
  quit      : () => ipcRenderer.send('window-close'),

  // 設定
  getConfig    : ()       => ipcRenderer.invoke('get-config'),
  saveConfig   : (config) => ipcRenderer.invoke('save-config', config),
  addUrlHistory: (url)    => ipcRenderer.invoke('add-url-history', url),

  // オーバーレイURL
  copyOverlayUrl: () => ipcRenderer.send('copy-overlay-url'),

  // トレイ更新
  updateTray: (data) => ipcRenderer.send('update-tray', data),

  // 外部リンクを開く
  openExternal  : (url) => ipcRenderer.invoke('open-external', url),

  // アップデート関連
  getVersion    : ()  => ipcRenderer.invoke('get-version'),
  checkUpdate   : ()  => ipcRenderer.invoke('check-update'),
  installUpdate : ()  => ipcRenderer.send('install-update'),
  onUpdateStatus: (cb) => ipcRenderer.on('update-status', (_, data) => cb(data)),
});
