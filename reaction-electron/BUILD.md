# ビルド・リリース手順

## 初回セットアップ

```cmd
cd reaction-electron
npm install
```

## 動作確認

```cmd
npm start
```

## ローカルビルドのみ

```cmd
npm run build
```

`dist/ReactionMilestone Setup x.x.x.exe` が生成される。

## GitHub Releases にリリース

```cmd
set GH_TOKEN=ghp_あなたのトークン
npm run release
```

その後 https://github.com/Luca3yt/YRCM/releases で **Draft を Publish する**。
Draft のままだと自動アップデートが動かない。

### GH_TOKEN の発行

1. https://github.com/settings/tokens
2. Generate new token (classic)
3. スコープは **repo** にチェック
4. 生成されたトークンをコピー（一度しか表示されない）

毎回入力したくない場合は Windows の環境変数に `GH_TOKEN` として登録する。

## バージョニング

`package.json` の `version` を編集してから `npm run release`。

| 種類 | 条件 | 例 |
|------|------|-----|
| メジャー | 互換性のない変更 | 1.0.0 → 2.0.0 |
| マイナー | 後方互換の機能追加 | 1.1.0 → 1.2.0 |
| パッチ | 後方互換のバグ修正 | 1.2.3 → 1.2.4 |

## 反映範囲

| 変更ファイル | npm start | EXE |
|-------------|-----------|-----|
| server.js / admin.html / overlay.html | 即反映 | リビルド必要 |
| main.js / preload.js | 再起動必要 | リビルド必要 |
