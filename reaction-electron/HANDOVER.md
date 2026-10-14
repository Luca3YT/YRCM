# YRCM 引継ぎ書（claude.ai → Claude Code）

最終更新: 2026-10-14 / 現在のバージョン: **v1.7.0**

---

## プロジェクト概要

**YRCM**（YouTube Reaction & Chat Milestone）
YouTube Live のリアクション数（ハート等）をリアルタイム集計し、マイルストーン達成時に OBS オーバーレイでエフェクトを出す Windows 向け Electron アプリ。

- GitHub: `Luca3yt/YRCM`（Public）
- 配布形式: GitHub Releases 経由の EXE インストーラ（electron-updater で自動更新）

---

## ファイル構成

```
reaction-electron/
├── main.js          Electron メインプロセス・トレイ・自動アップデート・IPC
├── preload.js       contextBridge（electronAPI）
├── server.js        HTTP(3000) / WebSocket(3001) サーバー・YouTube InnerTube API
├── admin.html       管理画面 UI（全ロジックが1ファイルに入っている）
├── overlay.html     OBS ブラウザソース用オーバーレイ
├── package.json     依存・electron-builder 設定
├── assets/
│   ├── icon.ico     Windows用（※要確認：ない場合は生成が必要）
│   └── icon.png
├── README.md
└── BUILD.md         ビルド・リリース手順
```

---

## アーキテクチャ

### データの流れ

```
YouTube InnerTube API
   ↓ (10秒ポーリング / server.js)
server.js
   ↓ WebSocket :3001 broadcast
admin.html（管理画面）/ overlay.html（OBS）
```

### WebSocket メッセージ（server → client）

| type | 受信側 | 内容 |
|------|--------|------|
| `init` | admin | 初期カウント・配信情報 |
| `update` | admin | カウント更新 |
| `milestone` | admin / overlay | マイルストーン達成 |
| `progress` | overlay | `!progress` コマンド結果 |
| `progress_cmd` | admin | コマンド実行ログ |
| `reaction_log` | admin | リアクション集計ログ |
| `viewers_update` | admin | 視聴者数＋履歴配列 |
| `session_summary` | admin | 配信サマリー（切断時） |
| `volume_update` | overlay | 音量・サウンド種類・カスタム音源 |
| `theme_update` | overlay | テーマ（studio / neon / minimal）。接続時にも送られる |
| `yt_status` | admin | 接続状態変化 |
| `sys_log` | admin | サーバー側エラーログ |
| `reset` | admin / overlay | リセット |

### HTTP API

| エンドポイント | 用途 |
|---------------|------|
| `POST /api/connect` | YouTube Live に接続 |
| `POST /api/disconnect` | 切断（**サマリーをbroadcastする**）→「配信終了」ボタン用 |
| `POST /api/disconnect-silent` | 切断（サマリーなし）→「切断」ボタン用 |
| `POST /api/reset` | カウントリセット |
| `POST /api/add` | 手動カウント加算（テストボタン・1〜100,000） |
| `GET /api/viewers` | 視聴者数の手動取得 |
| `POST /api/volume` | 音量・サウンド種類を overlay に中継（サーバーが最後の設定を保持し、overlay 接続時に送り直す） |
| `POST /api/theme` | テーマを overlay に中継（サーバーが保持し、overlay 接続時にも送る） |
| `POST /api/discord` | 配信サマリーを Discord WebHook に中継送信（discord.com の `/api/webhooks/` のみ許可） |
| `GET /api/status` | 現在の状態（※未使用） |

### IPC（preload.js の `electronAPI`）

`minimize` / `hide` / `quit` / `getConfig` / `saveConfig` / `addUrlHistory` / `copyOverlayUrl` / `updateTray` / `getVersion` / `checkUpdate` / `installUpdate` / `onUpdateStatus` / `openExternal`

---

## 主要機能

### 管理画面（admin.html）

**レイアウトは固定2カラム**。ドラッグ&ドロップ移動は**廃止済み**（`saveCardOrder` / `restoreCardOrder` は無効化されている）。

| 左列 | 右列 |
|------|------|
| YouTube Live 接続 | リアクション数 |
| システムログ | リアクションログ |
| 目標リスト | 目標リスト（表示用コピー） |
| 配信コマンド一覧 | サウンド |
| テスト | アップデート |
| OBS ブラウザソース | 設定 → テスト |

- 上部バナーの視聴者数をクリック → 同接グラフ（Canvas 折れ線＋面）が展開
- 目標リスト: タイトルクリックでモーダル。デフォルト値 `100,250,500,1000,1500,2000,2500,3000,4000,5000,7000,10000`
- カード表示はクリア2・挑戦中1・未来2 の最大5件スライド表示
- サウンド: 音量スライダー / ミュート / 種類5種（チャイム・ファンファーレ・ドラムロール・マジカル・ピンポン）+ カスタム音源
- 設定カード: テーマ切替（スタジオ / ネオン / ミニマル）と Discord WebHook URL（どちらも localStorage 保存）
- 配信サマリー: 「🎬 配信終了」で表示 → コピー / Discord送信 / 閉じる

### OBS オーバーレイ（overlay.html）

- キャッシュ未更新時は赤い警告オーバーレイ（WS接続成功で自動消滅）
- LIVE バッジは接続30秒後にフェードアウト
- マイルストーン達成時にエフェクト＋効果音（種類は admin から同期される）

### チャットコマンド（server.js）

`!progress` / `!prog` / `!p` / `進捗` / `どのくらい` / `どこまで` / `!進捗` / `!どのくらい`
**完全一致判定**。クールダウン10秒。全角半角・大文字小文字は自動正規化。

---

## 重要な実装上の注意（ハマりどころ）

### 1. レイアウトCSSは触らない

過去に何度も崩壊させた。**以下は絶対に追加しないこと**：

```css
align-items: start      /* NG */
height: fit-content     /* NG */
align-self: start       /* NG */
```

正しい現在の値：

```css
#content{flex:1;overflow:auto;padding:12px;display:grid;
  grid-template-columns:repeat(2,minmax(360px,1fr));gap:10px;align-content:start}
.card{background:var(--card);border:1px solid var(--border);
  border-radius:14px;padding:14px 16px;transition:opacity .2s,transform .2s}
```

`minmax(360px,1fr)` でカラムが360px以下に縮まない＝ウィンドウ縮小時はスクロールになる。

### 2. admin.html の関数が消えやすい

正規表現置換で編集してきた経緯があり、**関数定義だけ消えて呼び出しが残る**事故が複数回発生した。編集後は必ず以下を確認：

```bash
# HTMLから呼ばれる関数が全部定義されているかチェック
python3 -c "
import re
src=open('admin.html').read()
js=re.search(r'<script>(.*?)</script>',src,re.DOTALL).group(1)
defined=set(re.findall(r'function\s+(\w+)\s*\(',js))
called=set(re.findall(r'on\w+=\"(\w+)\(',src))
print('未定義:', called-defined-{'return','if','event','this'})
"
```

### 3. カスタムサウンドは Web Audio API のみ

Electron の Chromium は MP3 デコードに失敗することがあり、`new Audio()` は使わない。
ファイル選択時に `decodeAudioData` で即デコード・検証して `AudioBuffer` をメモリ保持し、再生時はそれを使う。**推奨形式は WAV / OGG**。

CSP に `blob:` が必要（admin.html の meta タグ）。

### 4. 視聴者数は専用エンドポイント

チャットのポーリングAPIには視聴者数が**入っていない**。
`/youtubei/v1/updated_metadata` から独立した10秒タイマー（`startViewersPolling`）で取得している。
返ってくるのは `"11,661 watching now"` のような文字列なので数字部分だけ抽出する。

### 5. 文字化け（npm start 時）

Electron のコンソールは Windows のコードページ制御が効かず `npm start` では日本語が化ける。**EXE ビルド後は化けない**ので開発時のみの問題として許容している。

### 6. WebSocket の再接続は onclose だけで行う

`ws.onclose = ws.onerror = () => setTimeout(connect, 3000)` と書くと、error と close の両方で再接続が走り、切断のたびに接続が倍々に増える（v1.6.2 まで実際に起きていた。overlay だと演出が何重にも出る）。再接続は `onclose` のみ、タイマーは1本に。

### 7. API / WebSocket は他サイトからのアクセスを拒否している

`server.js` の `isAllowedOrigin()`。Origin なし（OBS・curl）か、localhost / 同じホスト名からのみ許可。別PCのOBSから `http://<IP>:3000/overlay.html` で読む使い方も通る（未確認：実機の別PC構成では未テスト）。

### 8. ポーリングは世代番号（pollGeneration）で管理

切断→すぐ再接続したときに古い `pollLoop` が新しい接続に混ざって二重に回らないよう、接続・切断のたびに `pollGeneration` を進め、古い世代のループは自然終了させている。

### 9. 管理画面の electronAPI は `window.electronAPI?.` で呼ぶ

ブラウザで admin.html を開くと `electronAPI` 自体が未定義なので、`electronAPI?.xxx` だと ReferenceError で処理が止まる。

### 10. 色はテーマ変数だけで指定する（v1.7.0〜）

admin.html の色は `:root` / `[data-theme="..."]` の CSS 変数（`--bg` `--card` `--accent` `--success` など）で決まる。薄い色は `--accent-soft` のように `color-mix()` で作っている。**直書きの色（#fff や rgba(255,255,255,.x)）を足すとテーマ切替で浮く**ので、新しいUIも変数で書くこと。
overlay.html は `body[data-theme]` の `--t-*`（実績トースト）/ `--p-*`（進捗トースト）変数。
`.card` は CLAUDE.md の指定どおりの1行を残し、hover用の border-color 遷移は別の `.card{...}` ルールで足している。
admin.html の `<head>` にテーマ初期化用の `<script id="theme-boot">` がある（関数チェックの正規表現は `<script>` 完全一致なので影響なし）。

### 11. main.js / preload.js を変更したらリビルド必須

`server.js` / `admin.html` / `overlay.html` は `npm start` なら即反映されるが、EXE はいずれもリビルドが必要。

---

## ビルド・リリース手順

```cmd
cd reaction-electron
npm install

# 動作確認
npm start

# ローカルビルドのみ
npm run build

# GitHub Releases にリリース
set GH_TOKEN=ghp_xxxxx
npm run release
```

リリース後、https://github.com/Luca3yt/YRCM/releases で **Draft を Publish する**。
Draft のままだと自動アップデートが動かない。

### GH_TOKEN

https://github.com/settings/tokens で classic トークンを発行（スコープ `repo`）。
一度しか表示されないので控えておく。Windows 環境変数に `GH_TOKEN` として登録すれば毎回の入力を省ける。

### バージョニング（semver）

| 種類 | 条件 | 例 |
|------|------|-----|
| メジャー | 互換性のない変更 | 1.0.0 → 2.0.0 |
| マイナー | 後方互換の機能追加 | 1.1.0 → 1.2.0 |
| パッチ | 後方互換のバグ修正 | 1.2.3 → 1.2.4 |

---

## 作業スタイル（ユーザーの希望）

- 日本語・フランクな口調・結論を先に
- **実装前に仕様で迷う点は選択肢で質問する**（勝手に進めない）
- 見た目が絡むものは候補を見せてから選ばせる
- 頼んでない機能や確認ダイアログを足さない（提案だけにする）
- UI文言は自然な日本語（直訳っぽいのはNG）
- 変更のたびにバージョンを上げ、GitHub用リリースノートと README のバージョン履歴行も一緒に出す
- 渡す前に自分でテスト・動作確認する（「たぶん動く」はNG）
- iOS等の自信がない仕様は推測で言い切らず「未確認」と書く

---

## 未対応・保留中

- **セキュリティソフトの誤検知**（ノートン / Defender）
  コードサイニング証明書がないのが原因。ユーザー判断で**対応しないことにした**。
- `/api/status` が未使用のまま残っている（害はない）
- 配信サマリーの「配信時間」はアプリ起動（またはリセット）からの時間。YouTube に接続した時刻からではない（仕様判断待ち）
- 1回の加算で複数マイルストーンをまたぐと、2つ目以降の時速が 0 と表示される（テストの→5k などで起きる。実配信ではまず起きない）
- 目標リスト（管理画面）とマイルストーン（overlay の演出）は別物。目標を変えても overlay の演出タイミングは変わらない

---

## 直近の変更履歴

| バージョン | 内容 |
|------------|------|
| v1.7.0 | デザイン一新・テーマ切替（スタジオ / ネオン / ミニマル）追加 |
| v1.6.3 | バグ修正まとめ（下記「v1.6.3 の修正内容」参照） |
| v1.6.2 | 配信コマンドカードの開閉不能・「切断」でサマリーが出る・サウンド種類がoverlayに反映されない問題を修正 |
| v1.6.1 | Discord WebHook URL を設定カードに常設 |
| v1.6.0 | 同接グラフ / 配信サマリーの関数欠落を修正、Discord WebHook連携・デフォルト目標追加 |
| v1.5.11 | カスタムサウンドをWeb Audio API方式に全面変更 |
| v1.5.9 | 全カードが `#content` 内に入るよう修正（閉じタグ位置） |
| v1.5.7 | `minmax(360px,1fr)` でレイアウト崩れを解消 |
| v1.5.5 | レイアウトを固定2カラムに変更 |
| v1.5.0 | 目標リストカード追加 |

---

## v1.6.3 の修正内容

| 対象 | 内容 |
|------|------|
| admin / overlay | WebSocket 切断のたびに再接続が倍々に増える → overlay で演出・効果音が重複 |
| server | テストの「→1k」「→5k」が 100 しか加算されない（上限100だった） |
| server / admin | Discord 送信が CSP で必ず失敗 → サーバー経由（`/api/discord`）に変更 |
| server | overlay が再接続（OBSのキャッシュ更新など）するとサウンド設定がチャイムに戻る |
| server | 接続中に別URLで接続し直すと配信サマリーが出る |
| server | 切断→即再接続で古いポーリングが残り二重カウントの恐れ |
| server | 接続処理中に「切断」しても接続されてしまう |
| server | 壊れたJSONを送るとサーバーが落ちる恐れ / `../` でアプリ外のファイルが読める / 他サイトから API を叩ける |
| server | ポート使用中のときに原因不明のクラッシュ → 分かるメッセージを出して終了 |
| admin | 画面を開き直すたびに達成済みの目標通知がまとめて出る |
| admin | 開き直したとき YouTube 接続中なのに「未接続」表示 |
| admin | 目標を全部消すと右列の目標カードが更新されない |
| admin | 目標モーダルの外側クリックで閉じない |
| admin | カスタム音源使用時、音量スライダーを動かすたびに音源（数MB）を毎回送信 |
| admin | URL履歴に `"` などが入ると表示・選択が壊れる |
| admin | ブラウザで開くと `electronAPI` 未定義エラーでカウント処理が止まる |
| main | `assets/tray.png` が無くトレイアイコンが空 → icon.png を縮小して使う |
| main | `open-external` が http/https 以外も開ける / トレイの接続状態が次のリアクションまで更新されない |

