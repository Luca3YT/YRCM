'use strict';
// Windowsターミナル文字化け対策
// Electronはターミナルを直接持たないのでchcpは効かない
// 代わりにログをバッファリングせず直接Writeする
if (process.platform === 'win32') {
  try {
    // コンソールウィンドウのコードページをUTF-8に設定
    const ffi = (() => { try { return require('ffi-napi'); } catch(_) { return null; } })();
    if (!ffi) {
      // ffi未使用の場合: spawn時の環境変数でUTF-8を強制
      process.env.LANG = 'ja_JP.UTF-8';
    }
  } catch(_) {}
  // WriteConsoleWを使うためにSTDOUTをraw modeに
  try { process.stdout._handle?.setBlocking?.(true); } catch(_) {}
}

const { app, BrowserWindow, Tray, Menu, shell, ipcMain, nativeImage, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const path  = require('path');
const http  = require('http');
const https = require('https');
const zlib  = require('zlib');
const net   = require('net');
const crypto = require('crypto');
const fs    = require('fs');
const url   = require('url');

// ══════════════════════════════════════════
//  設定
// ══════════════════════════════════════════
const HTTP_PORT = 3000;
const WS_PORT   = 3001;
const CONFIG_FILE = path.join(app.getPath('userData'), 'config.json');

// ══════════════════════════════════════════
//  設定の読み書き（URLの履歴・自動起動など）
// ══════════════════════════════════════════
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch (e) {}
  return { urlHistory: [], autoLaunch: false };
}

function saveConfig(config) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
  } catch (e) {}
}

let config = loadConfig();

// ══════════════════════════════════════════
//  グローバル変数
// ══════════════════════════════════════════
let mainWindow  = null;
let tray        = null;
let isQuitting  = false;

// ══════════════════════════════════════════
//  Electronアプリ初期化
// ══════════════════════════════════════════
app.whenReady().then(() => {
  // 多重起動防止
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }
  app.on('second-instance', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  startServers();
  createTray();
  createWindow();

  // 自動アップデートチェック（起動5秒後に確認）
  setupAutoUpdater();

  // 自動起動設定を反映
  app.setLoginItemSettings({
    openAtLogin: config.autoLaunch ?? false,
    name: 'ReactionMilestone',
  });
});

// ══════════════════════════════════════════
//  メインウィンドウ
// ══════════════════════════════════════════
function createWindow() {
  mainWindow = new BrowserWindow({
    width : 820,
    height: 620,
    minWidth : 700,
    minHeight: 500,
    frame: false,           // カスタムタイトルバー
    transparent: false,
    backgroundColor: '#0b1020',
    webPreferences: {
      preload: path.join(app.getAppPath(), 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: path.join(app.getAppPath(), 'assets', 'icon.png'),
    show: false,
  });

  // サーバー起動後にlocalhost経由で開く（fetchがfile://にならないよう）
  // サーバーが準備できるまで少し待つ
  const tryLoad = (retries = 10) => {
    const req = require('http').get(`http://localhost:${HTTP_PORT}/admin.html`, (res) => {
      if (res.statusCode === 200) {
        mainWindow.loadURL(`http://localhost:${HTTP_PORT}/admin.html`);
      } else if (retries > 0) {
        setTimeout(() => tryLoad(retries - 1), 300);
      }
      res.resume();
    });
    req.on('error', () => {
      if (retries > 0) setTimeout(() => tryLoad(retries - 1), 300);
    });
    req.end();
  };
  tryLoad();

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // ×ボタンで閉じてもタスクトレイに残す
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
      tray.displayBalloon?.({
        iconType: 'info',
        title: 'ReactionMilestone',
        content: 'タスクトレイに常駐しています',
      });
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ══════════════════════════════════════════
//  タスクトレイ
// ══════════════════════════════════════════
function createTray() {
  // アイコン（tray.png が無ければアプリアイコンを縮小して使う）
  // 空アイコンだとタスクトレイに何も表示されず、常駐していても見つけられない
  const trayPath = path.join(app.getAppPath(), 'assets', 'tray.png');
  const appIconPath = path.join(app.getAppPath(), 'assets', 'icon.png');
  let icon = nativeImage.createEmpty();
  if (fs.existsSync(trayPath)) icon = nativeImage.createFromPath(trayPath);
  else if (fs.existsSync(appIconPath)) icon = nativeImage.createFromPath(appIconPath).resize({ width: 16, height: 16, quality: 'best' });

  tray = new Tray(icon);
  tray.setToolTip('ReactionMilestone');

  updateTrayMenu();

  tray.on('click', () => {
    if (mainWindow) {
      mainWindow.isVisible() ? mainWindow.focus() : mainWindow.show();
    } else {
      createWindow();
    }
  });
}

function updateTrayMenu(status = '未接続', count = 0) {
  const menu = Menu.buildFromTemplate([
    { label: `🎬 ReactionMilestone`, enabled: false },
    { label: `状態: ${status}`, enabled: false },
    { label: `リアクション: ${count.toLocaleString()}`, enabled: false },
    { type: 'separator' },
    { label: '管理画面を開く', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { label: 'OBSオーバーレイURLをコピー', click: copyOverlayUrl },
    { type: 'separator' },
    { label: '終了', click: () => { isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
}

function copyOverlayUrl() {
  const { clipboard } = require('electron');
  clipboard.writeText(`http://localhost:${HTTP_PORT}/overlay.html`);
}

// ══════════════════════════════════════════
//  IPC: レンダラー ↔ メインプロセス通信
// ══════════════════════════════════════════

// ウィンドウ操作（カスタムタイトルバー用）
ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-hide',     () => mainWindow?.hide());
ipcMain.on('window-close',    () => { isQuitting = true; app.quit(); });

// 設定の読み書き
ipcMain.handle('get-config', () => config);
ipcMain.handle('save-config', (_, newConfig) => {
  config = { ...config, ...newConfig };
  saveConfig(config);

  // 自動起動の反映
  app.setLoginItemSettings({
    openAtLogin: config.autoLaunch ?? false,
    name: 'ReactionMilestone',
  });
  return config;
});

// URL履歴の保存
ipcMain.handle('add-url-history', (_, liveUrl) => {
  if (!liveUrl) return config.urlHistory;
  const history = config.urlHistory.filter(u => u !== liveUrl);
  history.unshift(liveUrl);
  config.urlHistory = history.slice(0, 10); // 最大10件
  saveConfig(config);
  return config.urlHistory;
});

// オーバーレイURLをコピー
ipcMain.on('copy-overlay-url', copyOverlayUrl);

// バージョン取得
ipcMain.handle('get-version', () => app.getVersion());
ipcMain.handle('open-external', (_, url) => {
  // http/https 以外（file: や任意のプロトコル）は開かない
  if (!/^https?:\/\//i.test(String(url || ''))) return false;
  return shell.openExternal(url);
});

// アップデート確認（手動）
ipcMain.handle('check-update', () => {
  return autoUpdater.checkForUpdates().catch(e => {
    console.log('手動アップデート確認失敗:', e.message);
  });
});

// アップデートのインストール（再起動）
ipcMain.on('install-update', () => {
  isQuitting = true;
  autoUpdater.quitAndInstall();
});

// トレイメニュー更新（接続状態が変わったとき）
ipcMain.on('update-tray', (_, data) => {
  if (!tray) return;
  const { status, count } = data || {};
  updateTrayMenu(status || '未接続', Number(count) || 0);
});

// ══════════════════════════════════════════
//  サーバー起動（server.jsの内容をここに統合）
// ══════════════════════════════════════════

// ══════════════════════════════════════════
//  自動アップデート
// ══════════════════════════════════════════
// レンダラーにアップデート状態を送信するヘルパー
function sendUpdateStatus(data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-status', data);
  }
}

function setupAutoUpdater() {
  if (!app.isPackaged) {
    console.log('開発環境のためアップデートチェックをスキップ');
    // 開発中でもUIが動くようにダミーステータスを送る
    setTimeout(() => sendUpdateStatus({ status: 'not-available' }), 2000);
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  // 起動5秒後に自動チェック
  setTimeout(() => {
    sendUpdateStatus({ status: 'checking' });
    autoUpdater.checkForUpdates().catch(e => {
      console.log('アップデート確認失敗:', e.message);
      sendUpdateStatus({ status: 'error' });
    });
  }, 5000);

  autoUpdater.on('checking-for-update', () => {
    sendUpdateStatus({ status: 'checking' });
  });

  autoUpdater.on('update-available', (info) => {
    console.log(`🆕 アップデートあり: v${info.version}`);
    if (tray) tray.setToolTip(`ReactionMilestone - v${info.version}をダウンロード中...`);
    sendUpdateStatus({ status: 'available', version: info.version, notes: info.releaseNotes, releaseDate: info.releaseDate });
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log(`✅ ダウンロード完了: v${info.version}`);
    if (tray) tray.setToolTip('ReactionMilestone');
    sendUpdateStatus({ status: 'downloaded', version: info.version, notes: info.releaseNotes, releaseDate: info.releaseDate });
  });

  autoUpdater.on('update-not-available', () => {
    console.log('✅ 最新版を使用中');
    sendUpdateStatus({ status: 'not-available' });
  });

  autoUpdater.on('error', (e) => {
    console.error('アップデートエラー:', e.message);
    sendUpdateStatus({ status: 'error' });
  });
}

// server.jsをexe内でも正しいパスで読み込む
// electron-builderはasar形式でファイルをパッケージするため
// app.getAppPath() でアプリルートを取得する
function startServers() {
  try {
    const appRoot = app.getAppPath();
    const serverPath = path.join(appRoot, 'server.js');
    // server.js側がAPP_ROOTを参照できるようprocess.envに設定
    process.env.APP_ROOT = appRoot;
    console.log('APP_ROOT:', appRoot);
    console.log('server.js:', serverPath);
    require(serverPath);
    console.log('✅ サーバー起動成功');
  } catch (e) {
    console.error('❌ サーバー起動失敗:', e.message);
    dialog.showErrorBox('起動エラー', `サーバーの起動に失敗しました:\n${e.message}`);
  }
}

// ══════════════════════════════════════════
//  アプリ終了処理
// ══════════════════════════════════════════
app.on('window-all-closed', (e) => {
  // タスクトレイ常駐のため終了しない
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('activate', () => {
  if (!mainWindow) createWindow();
});
