# ReactionMilestone - Electron版

## フォルダ構成

```
reaction-electron/
├── main.js          ← Electronメインプロセス
├── preload.js       ← セキュアなIPC橋渡し
├── server.js        ← HTTPサーバー + WebSocket + YouTube接続
├── admin.html       ← 管理画面UI
├── overlay.html     ← OBSブラウザソース
├── package.json     ← プロジェクト設定
└── assets/
    └── icon.png     ← アプリアイコン（任意）
```

---

## 開発・動作確認（exeを作る前）

```bash
# 1. 依存パッケージをインストール
npm install

# 2. 起動
npm start
```

---

## exeビルド（Windows）

```bash
# 1. 依存パッケージをインストール（まだの場合）
npm install

# 2. ビルド実行（数分かかります）
npm run build
```

`dist/` フォルダに `ReactionMilestone Setup x.x.x.exe` が生成されます。
これをダブルクリックするとインストーラーが起動し、デスクトップにショートカットが作られます。

---

## アイコンを設定したい場合

`assets/` フォルダに以下のファイルを置く：
- `icon.ico`（256x256推奨）← ウィンドウアイコン・exeアイコン
- `icon.png`（256x256推奨）← タスクトレイアイコン

---

## OBSへの設定

1. ソース追加 → ブラウザ
2. URL: `http://localhost:3000/overlay.html`
3. 幅: `1920` / 高さ: `1080`
4. 背景透過にチェック

---

## 機能

- タスクトレイ常駐（×で閉じてもバックグラウンドで動作継続）
- PC起動時に自動スタート（設定画面でON/OFF）
- 配信URL履歴（最大10件）
- OBSオーバーレイURLをワンクリックコピー
