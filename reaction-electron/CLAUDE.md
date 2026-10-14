# YRCM 作業ルール

詳しい引継ぎは `HANDOVER.md`、ビルド手順は `BUILD.md` を参照。

## やりとり

- 日本語・フランクな口調・結論を先に
- **実装前に仕様で迷う点は選択肢で質問する**（勝手に進めない）
- 見た目が絡むものは候補を見せてから選ばせる
- 頼んでない機能や確認ダイアログを足さない（提案だけにする）
- UI文言は自然な日本語。直訳っぽい表現はNG
- 自信がない仕様は推測で言い切らず「未確認」と書く
- 渡す前に必ず動作確認する

## 変更のたびにやること

1. `package.json` の `version` を semver で上げる
2. GitHub 用リリースノートを出す
3. `README.md` のバージョン履歴に行を追加

## 絶対に触らないCSS

レイアウトが何度も崩壊した。以下は**追加禁止**：

```css
align-items: start      /* NG */
height: fit-content     /* NG */
align-self: start       /* NG */
```

現在の正しい値（admin.html）:

```css
#content{flex:1;overflow:auto;padding:12px;display:grid;
  grid-template-columns:repeat(2,minmax(360px,1fr));gap:10px;align-content:start}
.card{background:var(--card);border:1px solid var(--border);
  border-radius:14px;padding:14px 16px;transition:opacity .2s,transform .2s}
```

カードのレイアウトは**固定2カラム**。ドラッグ移動は廃止済み。

## admin.html を編集したら必ず実行

正規表現置換で関数定義だけ消える事故が何度も起きている。

```bash
python3 -c "
import re
src=open('admin.html').read()
js=re.search(r'<script>(.*?)</script>',src,re.DOTALL).group(1)
defined=set(re.findall(r'function\s+(\w+)\s*\(',js))
called=set(re.findall(r'on\w+=\"(\w+)\(',src))
print('未定義:', called-defined-{'return','if','event','this'})
"
```

## その他の地雷

- カスタムサウンドは `new Audio()` を使わない。Web Audio API の `decodeAudioData` のみ（Electron が MP3 デコードに失敗する）
- 視聴者数はチャットAPIには入っていない。`/youtubei/v1/updated_metadata` から別タイマーで取得
- `npm start` の文字化けは Electron の仕様。EXE では化けないので放置でよい
- WebSocket の再接続は `onclose` だけで行う（`onclose = onerror = ...` は接続が倍々に増える）
- admin.html から Electron の API を呼ぶときは `window.electronAPI?.xxx`（ブラウザで開くと未定義で止まる）
- `main.js` / `preload.js` を変えたらリビルド必須
