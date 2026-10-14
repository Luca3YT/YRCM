/**
 * Reaction Milestone Server v2
 * YouTube Live リアクション検知 + OBSオーバーレイ WebSocketサーバー
 *
 * Node.js標準モジュールのみ（npm install 不要）
 * 起動: node server.js
 */

'use strict';
// Windowsターミナル文字化け対策: WriteConsoleW を使う
if (process.platform === 'win32') {
  const { execFileSync } = require('child_process');
  try { execFileSync('cmd', ['/c', 'chcp', '65001'], { stdio: 'pipe' }); } catch(_) {}
  // Node.jsのコンソール出力をUTF-8に
  process.stdout._handle?.setBlocking?.(true);
  try {
    const binding = process.binding('stdio');
    if (binding && binding.guessHandleType(1) === 'CONSOLE') {
      // コンソールのコードページをUTF-8に
    }
  } catch(_) {}
}

const http   = require('http');
const https  = require('https');
const zlib   = require('zlib');
const net    = require('net');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const url    = require('url');

// ══════════════════════════════════════════
//  設定
// ══════════════════════════════════════════
const HTTP_PORT = 3000;
const WS_PORT   = 3001;
const MILESTONES = [100, 500, 1000, 2000, 3000, 5000, 7500, 10000, 15000, 20000, 30000, 50000];

// YouTubeへのリクエストで使うブラウザ偽装ヘッダー
const YT_CLIENT_VERSION = '2.20250530.01.00';
const FAKE_HEADERS = {
  'User-Agent'             : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
  'Accept'                 : '*/*',
  'Accept-Language'        : 'ja,en-US;q=0.9,en;q=0.8',
  'Accept-Encoding'        : 'gzip, deflate, br',
  'Origin'                 : 'https://www.youtube.com',
  'Referer'                : 'https://www.youtube.com/',
  'x-youtube-client-name' : '1',
  'x-youtube-client-version': YT_CLIENT_VERSION,
  'Content-Type'           : 'application/json',
};

// InnerTube context（POSTボディに含める）
function makeContext() {
  return {
    client: {
      clientName   : 'WEB',
      clientVersion: YT_CLIENT_VERSION,
      hl           : 'ja',
      gl           : 'JP',
      userAgent    : FAKE_HEADERS['User-Agent'],
    }
  };
}

// ══════════════════════════════════════════
//  状態管理
// ══════════════════════════════════════════
let totalCount        = 0;
let sessionStart      = Date.now();
let lastMilestoneCount = 0;
let lastMilestoneTime  = Date.now();
const achievedMilestones = new Set();
let viewersHistory     = []; // 視聴者数履歴（グラフ用）最大200件
// 最後に受け取ったサウンド設定（overlayが後から接続・再接続したときに送り直す）
let soundSettings      = null; // { volume, soundType, customSoundB64 }
// 接続ごとに増える番号。古いポーリングが新しい接続に混ざるのを防ぐ
let pollGeneration     = 0;

// YouTube接続状態
let ytState = {
  connected   : false,
  videoId     : null,
  apiKey      : null,
  continuation: null,
  pollTimer   : null,
  seenIds     : new Set(), // 重複イベント防止
  title       : '',
  channel     : '',
  viewers     : '',
};

// ══════════════════════════════════════════
//  カウント処理・マイルストーン
// ══════════════════════════════════════════
function addCount(amount, emojiMap = {}) {
  totalCount += amount;
  broadcast({ type: 'update', count: totalCount });
  // 絵文字情報付きリアクションログ
  broadcast({ type: 'reaction_log', amount, total: totalCount, emojiMap, ts: Date.now() });
  checkMilestones();
}

function checkMilestones() {
  for (const m of MILESTONES) {
    if (totalCount >= m && !achievedMilestones.has(m)) {
      achievedMilestones.add(m);
      const segReactions = m - lastMilestoneCount;
      const segMs        = Date.now() - lastMilestoneTime;
      const speed        = segMs > 0 ? Math.round(segReactions / (segMs / 3_600_000)) : 0;
      const elapsedMs    = Date.now() - sessionStart;
      broadcast({ type: 'milestone', milestone: m, speed, elapsedMs });
      lastMilestoneCount = m;
      lastMilestoneTime  = Date.now();
      console.log(`🏆 Milestone! ${m.toLocaleString()} (時速${speed.toLocaleString()})`);
    }
  }
}

function resetAll() {
  totalCount = 0;
  sessionStart = lastMilestoneTime = Date.now();
  lastMilestoneCount = 0;
  achievedMilestones.clear();
  ytState.seenIds.clear();
  viewersHistory = [];
  broadcast({ type: 'reset' });
  console.log('🔄 リセットしました');
}

// ══════════════════════════════════════════
//  YouTube InnerTube API 接続
// ══════════════════════════════════════════

/** videoIdを配信URLから抽出 */
function extractVideoId(rawUrl) {
  try {
    // https://www.youtube.com/watch?v=XXXX
    // https://youtu.be/XXXX
    // https://www.youtube.com/live/XXXX
    const u = new url.URL(rawUrl);
    if (u.searchParams.get('v')) return u.searchParams.get('v');
    const m = u.pathname.match(/(?:live\/|embed\/|shorts\/)([A-Za-z0-9_-]{11})/);
    if (m) return m[1];
    // youtu.be
    if (u.hostname === 'youtu.be') return u.pathname.slice(1).split('/')[0];
  } catch (e) {}
  // 生のvideoId（11文字）
  if (/^[A-Za-z0-9_-]{11}$/.test(rawUrl.trim())) return rawUrl.trim();
  return null;
}

// ══════════════════════════════════════════
//  レスポンス解凍ユーティリティ
//  YouTubeはgzip/brotli圧縮で返すので必ず解凍する
// ══════════════════════════════════════════
function decompressResponse(res, buf) {
  return new Promise((resolve, reject) => {
    const enc = (res.headers['content-encoding'] || '').toLowerCase();
    if (enc.includes('br')) {
      zlib.brotliDecompress(buf, (e, r) => e ? reject(e) : resolve(r));
    } else if (enc.includes('gzip')) {
      zlib.gunzip(buf, (e, r) => e ? reject(e) : resolve(r));
    } else if (enc.includes('deflate')) {
      zlib.inflate(buf, (e, r) => e ? reject(e) : resolve(r));
    } else {
      resolve(buf);
    }
  });
}

/** YouTubeページHTMLを取得し continuation と apiKey を抽出 */
async function fetchYtPage(videoId) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'www.youtube.com',
      path    : `/watch?v=${videoId}`,
      method  : 'GET',
      headers : {
        'User-Agent'     : FAKE_HEADERS['User-Agent'],
        'Accept-Language': FAKE_HEADERS['Accept-Language'],
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept'         : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      }
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', async () => {
        try {
          const raw  = await decompressResponse(res, Buffer.concat(chunks));
          const data = raw.toString('utf8');

          const apiKeyMatch = data.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
          const apiKey = apiKeyMatch ? apiKeyMatch[1] : 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';

          const continuations = [...data.matchAll(/"continuation":"([^"]{20,})"/g)].map(m => m[1]);
          if (continuations.length === 0) {
            return reject(new Error('continuationが見つかりません。ライブ配信中か確認してください。'));
          }
          const continuation = continuations.reduce((a, b) => a.length >= b.length ? a : b);

          // 配信情報を取得
          const titleMatch   = data.match(/"title"\s*:\s*"([^"]+)"/);
          const title        = titleMatch ? titleMatch[1].replace(/\\u([\dA-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))) : '';
          const channelMatch = data.match(/"author"\s*:\s*"([^"]+)"/);
          const channel      = channelMatch ? channelMatch[1] : '';
          // 視聴者数
          const viewerMatch  = data.match(/"viewCount"\s*:\s*\{\s*"runs"\s*:\s*\[\s*\{\s*"text"\s*:\s*"([^"]+)"/);
          const viewers      = viewerMatch ? viewerMatch[1] : '';

          resolve({ apiKey, continuation, title, channel, viewers });
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('タイムアウト')); });
    req.end();
  });
}

/** live_chat API を1回叩く */
async function fetchLiveChat(apiKey, continuation) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      context     : makeContext(),
      continuation: continuation,
    });

    const options = {
      hostname: 'www.youtube.com',
      path    : `/youtubei/v1/live_chat/get_live_chat?key=${apiKey}&prettyPrint=false`,
      method  : 'POST',
      headers : {
        ...FAKE_HEADERS,
        'Accept-Encoding': 'gzip, deflate, br',
        'Content-Length' : Buffer.byteLength(body),
      }
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', async () => {
        try {
          const raw  = await decompressResponse(res, Buffer.concat(chunks));
          const json = JSON.parse(raw.toString('utf8'));
          resolve(json);
        } catch (e) {
          reject(new Error(`JSONパースエラー: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('タイムアウト')); });
    req.write(body);
    req.end();
  });
}

/**
 * !progress / !prog / !p / 進捗 / どのくらい / どこまで
 * などのコマンドをチャットで検知してprogress通知を送る
 * 連打防止のため10秒クールダウン付き
 */
let lastProgressTime = 0;
const PROGRESS_COOLDOWN_MS = 10 * 1000; // 10秒（コマンド方式なので短めに）

// 反応するコマンド一覧（小文字・全角半角統一して比較）
const PROGRESS_COMMANDS = [
  '!progress', '!prog', '!p',
  '進捗', 'どのくらい', 'どこまで',
  '!進捗', '!どのくらい',
];

function normalizeText(text) {
  return text
    .toLowerCase()
    .trim()
    // 全角英数→半角
    .replace(/[Ａ-Ｚａ-ｚ０-９！]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0))
    .replace(/　/g, ' ');
}

function isProgressCommand(text) {
  const normalized = normalizeText(text);
  return PROGRESS_COMMANDS.some(cmd => normalized === normalizeText(cmd));
}

function broadcastProgress() {
  const now = Date.now();
  if (now - lastProgressTime < PROGRESS_COOLDOWN_MS) return;
  lastProgressTime = now;

  const prevM    = MILESTONES.filter(m => m <= totalCount).pop() ?? 0;
  const nextM    = MILESTONES.find(m => m > totalCount) ?? null;
  const pct      = nextM ? Math.round(((totalCount - prevM) / (nextM - prevM)) * 100) : 100;
  const segMs    = now - lastMilestoneTime;
  const segRxn   = totalCount - lastMilestoneCount;
  const speed    = segMs > 0 ? Math.round(segRxn / (segMs / 3_600_000)) : 0;
  const remaining = nextM ? nextM - totalCount : 0;
  const elapsedMs = now - sessionStart;

  broadcast({ type: 'progress', count: totalCount, prevM, nextM, pct, speed, remaining, elapsedMs });
  console.log(`📊 進捗通知: ${totalCount.toLocaleString()} / 次→${nextM?.toLocaleString() ?? 'MAX'} (${pct}%)`);
}

function parseChats(data) {
  try {
    const actions = data?.continuationContents?.liveChatContinuation?.actions ?? [];
    for (const action of actions) {
      const renderer = action?.addChatItemAction?.item?.liveChatTextMessageRenderer;
      if (!renderer) continue;

      // テキストを取得（runs配列を結合）
      const text = (renderer?.message?.runs ?? [])
        .map(r => r.text ?? '')
        .join('');

      if (isProgressCommand(text)) {
        const author = renderer?.authorName?.simpleText ?? '?';
        console.log(`💬 進捗コマンド検知: "${text}" by ${author}`);
        // !progressログをadminに送信
        broadcast({ type: 'progress_cmd', author, command: text, ts: Date.now() });
        broadcastProgress();
        break; // 同じポーリング内で複数あっても1回だけ
      }
    }
  } catch (e) {
    console.error('parseChatsエラー:', e.message);
  }
}

/**
 * live_chatレスポンスからリアクション数をパースして返す
 *
 * リアクション（絵文字タップ）は actions ではなく
 * frameworkUpdates.entityBatchUpdate.mutations の中の
 * emojiFountainDataEntity.reactionBuckets に入っている
 *
 * 例:
 *   reactionBuckets: [{
 *     totalReactions: 2,
 *     reactionsData: [{ unicodeEmojiId: "❤", reactionCount: 2 }]
 *   }]
 */
function parseReactions(data) {
  let count = 0;
  // 絵文字ごとの集計 { "❤": 3, "👍": 1, ... }
  const emojiMap = {};

  try {
    const mutations = data?.frameworkUpdates
      ?.entityBatchUpdate?.mutations ?? [];

    for (const mutation of mutations) {
      const entity = mutation?.payload?.emojiFountainDataEntity;
      if (!entity) continue;

      const updateTime = entity.updateTimeUsec;
      if (updateTime && ytState.seenIds.has(updateTime)) continue;
      if (updateTime) ytState.seenIds.add(updateTime);

      const buckets = entity.reactionBuckets ?? [];
      for (const bucket of buckets) {
        const total = bucket.totalReactions ?? 0;
        if (total > 0) {
          count += total;
          for (const r of (bucket.reactionsData ?? [])) {
            const emoji = r.unicodeEmojiId || '❓';
            emojiMap[emoji] = (emojiMap[emoji] ?? 0) + (r.reactionCount ?? 0);
          }
          const detail = (bucket.reactionsData ?? [])
            .map(r => `${r.unicodeEmojiId}×${r.reactionCount}`)
            .join(' ');
          console.log(`  ✨ reactionBucket: +${total} (${detail})`);
        }
      }
    }
  } catch (e) {
    console.error('parseReactionsエラー:', e.message);
  }

  if (ytState.seenIds.size > 5000) {
    const arr = [...ytState.seenIds];
    ytState.seenIds = new Set(arr.slice(arr.length - 2000));
  }

  // 絵文字情報を返す
  return { count, emojiMap };
}

/** 次のcontinuationトークンを取得 */
function extractNextContinuation(data) {
  try {
    const continuations = data?.continuationContents
      ?.liveChatContinuation?.continuations ?? [];
    for (const c of continuations) {
      const token = c?.invalidationContinuationData?.continuation
        ?? c?.timedContinuationData?.continuation
        ?? c?.liveChatReplayContinuationData?.continuation  // アーカイブ用
        ?? null;
      if (token) return token;
    }
  } catch (e) {}
  return null;
}

/** ポーリング間隔を取得（YouTubeが指定してくる） */
// 視聴者数を抽出
function extractViewerCount(data) {
  // updated_metadata API で取得するためここでは使わない（常にnullを返す）
  return null;
}

// 視聴者数ポーリングタイマー（pollLoopとは独立）
let viewersTimer = null;

function startViewersPolling() {
  stopViewersPolling();
  const tick = () => {
    if (!ytState.connected) return;
    fetchViewerCount(ytState.videoId, ytState.apiKey).then(newViewers => {
      if (newViewers && newViewers !== ytState.viewers) {
        ytState.viewers = newViewers;
        viewersHistory.push({ t: Date.now(), v: newViewers });
        if (viewersHistory.length > 200) viewersHistory.shift();
        broadcast({ type: 'viewers_update', viewers: newViewers, history: viewersHistory });
        console.log('👥 視聴者数更新:', newViewers);
      }
    }).catch(e => {
      const msg = '👥 視聴者数取得エラー: ' + e.message;
      console.error(msg);
      broadcast({ type: 'sys_log', level: 'error', text: msg });
    });
    viewersTimer = setTimeout(tick, 10000); // 10秒ごと
  };
  viewersTimer = setTimeout(tick, 3000); // 接続後3秒後に初回取得
}

function stopViewersPolling() {
  if (viewersTimer) { clearTimeout(viewersTimer); viewersTimer = null; }
}

// 視聴者数専用エンドポイントから取得
async function fetchViewerCount(videoId, apiKey) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      context: {
        client: { clientName: 'WEB', clientVersion: '2.20240101' }
      },
      videoId: videoId
    });
    const options = {
      hostname: 'www.youtube.com',
      path    : `/youtubei/v1/updated_metadata?key=${apiKey}`,
      method  : 'POST',
      headers : {
        'Content-Type'   : 'application/json',
        'User-Agent'     : FAKE_HEADERS['User-Agent'],
        'Accept-Language': FAKE_HEADERS['Accept-Language'],
        'X-YouTube-Client-Name'   : '1',
        'X-YouTube-Client-Version': '2.20240101',
      }
    };
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', async () => {
        try {
          const raw  = await decompressResponse(res, Buffer.concat(chunks));
          const json = JSON.parse(raw.toString('utf8'));

          // actions[].updateViewershipAction.viewCount.videoViewCountRenderer
          // テキストから数字だけ抽出して整形する関数
          const toNum = (text) => {
            if (!text) return null;
            // "11,661 watching now" → "11,661"
            const m = String(text).match(/^([0-9,，]+)/);
            if (m) {
              const n = parseInt(m[1].replace(/[,，]/g, ''));
              return isNaN(n) ? null : n.toLocaleString('ja-JP');
            }
            return null;
          };

          const actions = json?.actions ?? [];
          for (const a of actions) {
            const vcr = a?.updateViewershipAction?.viewCount?.videoViewCountRenderer;
            if (vcr) {
              const raw = vcr?.viewCount?.runs?.map(r => r.text).join('')
                       || vcr?.viewCount?.simpleText
                       || vcr?.shortViewCount?.simpleText
                       || vcr?.originalViewCount
                       || '';
              const num = toNum(raw);
              if (num) return resolve(num);
            }
          }
          // フォールバック: originalViewCount
          const str = JSON.stringify(json);
          const m = str.match(/"originalViewCount"\s*:\s*"?([0-9]+)"?/);
          if (m) return resolve(parseInt(m[1]).toLocaleString('ja-JP'));

          resolve(null);
        } catch(e) {
          const msg = '👥 視聴者数パースエラー: ' + e.message;
          console.error(msg);
          broadcast({ type: 'sys_log', level: 'error', text: msg });
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

function extractPollingInterval(data) {
  try {
    const continuations = data?.continuationContents
      ?.liveChatContinuation?.continuations ?? [];
    for (const c of continuations) {
      const ms = c?.invalidationContinuationData?.timeoutMs
        ?? c?.timedContinuationData?.timeoutMs
        ?? null;
      if (ms) return Math.max(ms, 1000); // 最低1秒
    }
  } catch (e) {}
  return 5000; // デフォルト5秒
}

/** ポーリングループ */
async function pollLoop(gen = pollGeneration) {
  if (gen !== pollGeneration || !ytState.connected || !ytState.continuation) return;

  try {
    const data = await fetchLiveChat(ytState.apiKey, ytState.continuation);
    // 待っている間に切断・再接続されていたら、この結果は捨てる
    if (gen !== pollGeneration || !ytState.connected) return;

    const { count, emojiMap } = parseReactions(data);
    if (count > 0) addCount(count, emojiMap);

    // チャット検知 → 進捗通知（60秒クールダウン）
    parseChats(data);

    // 次のcontinuationとポーリング間隔を取得
    const nextCont = extractNextContinuation(data);
    const interval = extractPollingInterval(data);

    if (nextCont) {
      ytState.continuation = nextCont;
    } else {
      console.warn('⚠️ nextContinuationが取得できませんでした。再試行します。');
    }

    // ③ 視聴者数は独立タイマーで管理（startViewersPolling参照）
    ytState.pollTimer = setTimeout(() => pollLoop(gen), interval);

  } catch (e) {
    if (gen !== pollGeneration || !ytState.connected) return;
    console.error('❌ ポーリングエラー:', e.message);
    // エラー時は10秒後にリトライ
    ytState.pollTimer = setTimeout(() => pollLoop(gen), 10000);
    broadcastYtStatus();
  }
}

/** デバッグ用: 未知のrendererを出力（開発時に仕様を調べるため） */
function logUnknownRenderers(data) {
  const knownRenderers = new Set([
    'liveChatTextMessageRenderer',
    'liveChatPaidMessageRenderer',
    'liveChatPaidStickerRenderer',
    'liveChatMembershipItemRenderer',
    'liveChatReactionButtonRenderer',
    'liveChatEmojiFountainRenderer',
    'liveChatRecognitionAnnouncementRenderer',
    'liveChatTickerPaidMessageItemRenderer',
    'liveChatViewerEngagementMessageRenderer',
    'liveChatModeChangeMessageRenderer',
  ]);

  try {
    const actions = data?.continuationContents?.liveChatContinuation?.actions ?? [];
    for (const action of actions) {
      const item = action?.addChatItemAction?.item;
      if (!item) continue;
      const keys = Object.keys(item);
      for (const k of keys) {
        if (!knownRenderers.has(k)) {
          console.log(`🔍 未知のrenderer発見: ${k} →`, JSON.stringify(item[k]).slice(0, 120));
        }
      }
    }
  } catch (e) {}
}

/** YouTube接続開始 */
async function connectYouTube(rawUrl) {
  // 既存の接続を切断（つなぎ直しなのでサマリーは出さない）
  if (ytState.connected) disconnectYouTube('reconnect', { silent: true });

  const videoId = extractVideoId(rawUrl);
  if (!videoId) {
    broadcastYtStatus('invalid_url');
    return { ok: false, error: '無効なURLです' };
  }

  console.log(`\n🔗 YouTube接続開始: ${videoId}`);
  broadcastYtStatus('connecting');
  const gen = ++pollGeneration;

  try {
    const { apiKey, continuation, title, channel, viewers } = await fetchYtPage(videoId);
    // ページ取得中に「切断」や別URLでの接続が押されていたら何もしない
    if (gen !== pollGeneration) return { ok: false, error: '接続がキャンセルされました' };
    ytState.connected    = true;
    ytState.videoId      = videoId;
    ytState.apiKey       = apiKey;
    ytState.continuation = continuation;
    ytState.title        = title || '';
    ytState.channel      = channel || '';
    ytState.viewers      = viewers || '';

    console.log(`✅ 接続成功! タイトル: ${ytState.title}`);
    broadcastYtStatus('connected');

    // ポーリング開始
    pollLoop(gen);
    startViewersPolling();

    return { ok: true, videoId };
  } catch (e) {
    if (gen !== pollGeneration) return { ok: false, error: '接続がキャンセルされました' };
    console.error(`❌ 接続失敗: ${e.message}`);
    broadcastYtStatus('error');
    return { ok: false, error: e.message };
  }
}

/** YouTube切断 */
function disconnectYouTube(reason = 'manual', { silent = false } = {}) {
  // 接続処理中・ポーリング中のものをすべて無効化
  pollGeneration++;

  if (!ytState.connected) {
    broadcastYtStatus('disconnected');
    return;
  }

  // ④ 切断前にセッションサマリーをbroadcast（「切断」ボタン・つなぎ直しでは出さない）
  if (!silent) broadcastSessionSummary(reason);

  clearTimeout(ytState.pollTimer);
  stopViewersPolling();
  ytState.connected    = false;
  ytState.videoId      = null;
  ytState.apiKey       = null;
  ytState.continuation = null;
  ytState.pollTimer    = null;
  ytState.title        = '';
  ytState.channel      = '';
  ytState.viewers      = '';
  ytState.seenIds      = new Set();
  broadcastYtStatus('disconnected');
  console.log(`🔌 YouTube切断 (${reason}${silent ? '・サマリーなし' : ''})`);
}

function broadcastSessionSummary(reason) {
  const elapsed = Date.now() - sessionStart;
  const h  = Math.floor(elapsed / 3600000);
  const m  = Math.floor((elapsed % 3600000) / 60000);
  const s  = Math.floor((elapsed % 60000) / 1000);
  const durationStr    = h > 0 ? `${h}時間${m}分` : m > 0 ? `${m}分${s}秒` : `${s}秒`;
  const speedPerHour   = elapsed > 0 ? Math.round(totalCount / (elapsed / 3600000)) : 0;

  broadcast({
    type        : 'session_summary',
    totalCount,
    achieved    : [...achievedMilestones],
    duration    : durationStr,
    elapsedMs   : elapsed,
    speedPerHour,
    title       : ytState.title   || '',
    channel     : ytState.channel || '',
    videoId     : ytState.videoId || '',
    reason,
  });
}

function broadcastYtStatus(status) {
  broadcast({
    type    : 'yt_status',
    status  : status ?? (ytState.connected ? 'connected' : 'disconnected'),
    videoId : ytState.videoId,
    title   : ytState.title,
    channel : ytState.channel,
    viewers : ytState.viewers,
    count   : totalCount,
  });
}

// ══════════════════════════════════════════
//  HTTP サーバー（管理画面 + 静的ファイル）
// ══════════════════════════════════════════
/**
 * 他のWebサイトから localhost の API を叩かれないようにする。
 * Origin が無い（OBS・curl 等）か、localhost / 同じホスト名からのアクセスだけ許可。
 */
function isAllowedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin || origin === 'null') return !origin;
  try {
    const o = new url.URL(origin).hostname.replace(/^\[|\]$/g, '');
    const host = String(req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    return ['localhost', '127.0.0.1', '::1'].includes(o) || o === host;
  } catch (e) {
    return false;
  }
}

const httpServer = http.createServer((req, res) => {
  handleHttp(req, res).catch((e) => {
    console.error('HTTPエラー:', e.message);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
});

async function handleHttp(req, res) {
  if (req.url.startsWith('/api/') && !isAllowedOrigin(req)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── API: ステータス取得
  if (req.url === '/api/status' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      count    : totalCount,
      connected: ytState.connected,
      videoId  : ytState.videoId,
      sessionStart,
      achieved : [...achievedMilestones],
    }));
    return;
  }

  // ── API: YouTube接続
  if (req.url === '/api/connect' && req.method === 'POST') {
    const { liveUrl } = parseJson(await readBody(req));
    const result = await connectYouTube(String(liveUrl || ''));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  // ── API: YouTube切断
  if (req.url === '/api/disconnect' && req.method === 'POST') {
    disconnectYouTube();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // サイレント切断（サマリーbroadcastなし・切断ボタン用）
  if (req.url === '/api/disconnect-silent' && req.method === 'POST') {
    disconnectYouTube('manual', { silent: true });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ── API: リセット
  if (req.url === '/api/reset' && req.method === 'POST') {
    resetAll();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.url === '/api/viewers' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, viewers: ytState.viewers || null, history: viewersHistory }));
    return;
  }

  if (req.url === '/api/volume' && req.method === 'POST') {
    const { volume, soundType, customSoundB64 } = parseJson(await readBody(req));
    const vol = Number(volume);
    soundSettings = {
      volume        : Number.isFinite(vol) ? Math.max(0, Math.min(1, vol)) : 1,
      soundType     : soundType || 'chime',
      // 音源は送られてきたときだけ差し替える（音量変更のたびに数MBを送らないため）
      customSoundB64: customSoundB64 || soundSettings?.customSoundB64 || null,
    };
    broadcast({
      type          : 'volume_update',
      volume        : soundSettings.volume,
      soundType     : soundSettings.soundType,
      customSoundB64: customSoundB64 || null,
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ── API: 配信サマリーを Discord WebHook に送る
  // 管理画面から直接送ると CSP / CORS で弾かれるのでサーバー経由にする
  if (req.url === '/api/discord' && req.method === 'POST') {
    const { webhookUrl, content } = parseJson(await readBody(req));
    const result = await postDiscordWebhook(String(webhookUrl || ''), String(content || ''));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  // ── API: 手動カウント加算（テスト用）
  if (req.url === '/api/add' && req.method === 'POST') {
    const { amount } = parseJson(await readBody(req));
    addCount(clampTestAmount(amount));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, count: totalCount }));
    return;
  }

  // ── 静的ファイル配信
  const urlPath  = req.url === '/' ? '/admin.html' : req.url;
  // exe化したときも正しくファイルを見つけるためAPP_ROOTを優先
  const appRoot  = path.resolve(process.env.APP_ROOT || __dirname);
  let relPath;
  try { relPath = decodeURIComponent(urlPath.split('?')[0]); }
  catch (e) { res.writeHead(400); res.end('Bad request'); return; }
  const filePath = path.resolve(appRoot, '.' + path.posix.normalize('/' + relPath));
  // アプリフォルダの外（../ など）は返さない
  if (!filePath.startsWith(appRoot + path.sep)) { res.writeHead(404); res.end('Not found'); return; }
  const ext  = path.extname(filePath);
  const mime = {
    '.html': 'text/html', '.js': 'application/javascript',
    '.css' : 'text/css',  '.png': 'image/png', '.svg': 'image/svg+xml'
  }[ext] || 'text/plain';

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': mime + '; charset=utf-8' });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => resolve(body));
    req.on('error', () => resolve(''));
  });
}

// 壊れたJSONが来てもサーバーごと落ちないようにする
function parseJson(body) {
  try {
    const v = JSON.parse(body || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch (e) {
    return {};
  }
}

// テスト加算の量（→5k などのジャンプでも届くよう上限は大きめ）
const TEST_ADD_MAX = 100000;
function clampTestAmount(amount) {
  const n = parseInt(amount);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, TEST_ADD_MAX);
}

function postDiscordWebhook(webhookUrl, content) {
  return new Promise((resolve) => {
    let u;
    try { u = new url.URL(webhookUrl); } catch (e) { return resolve({ ok: false, error: 'URLの形式が正しくありません' }); }
    const hostOk = ['discord.com', 'discordapp.com', 'canary.discord.com', 'ptb.discord.com'].includes(u.hostname);
    if (u.protocol !== 'https:' || !hostOk || !u.pathname.startsWith('/api/webhooks/')) {
      return resolve({ ok: false, error: 'Discord の WebHook URL ではありません' });
    }
    if (!content) return resolve({ ok: false, error: '送る内容がありません' });

    const body = JSON.stringify({ content: content.slice(0, 2000) }); // Discordの上限は2000文字
    const req = https.request({
      hostname: u.hostname,
      path    : u.pathname + u.search,
      method  : 'POST',
      headers : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      res.resume();
      res.on('end', () => {
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        resolve(ok ? { ok: true } : { ok: false, error: `Discordがエラーを返しました（${res.statusCode}）` });
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.setTimeout(10000, () => { req.destroy(); resolve({ ok: false, error: 'タイムアウト' }); });
    req.write(body);
    req.end();
  });
}

// ポートが他のアプリに使われているときなどに、原因が分かるようにして終了する
function onListenError(name, port) {
  return (e) => {
    const msg = e.code === 'EADDRINUSE'
      ? `ポート ${port}（${name}）がすでに使われています。\nYRCM が二重に起動していないか、他のアプリが ${port} 番を使っていないか確認してください。`
      : `${name} の起動に失敗しました: ${e.message}`;
    console.error('❌ ' + msg);
    if (process.versions.electron) {
      try {
        const { dialog, app } = require('electron');
        dialog.showErrorBox('起動エラー', msg);
        app.exit(1);
        return;
      } catch (_) {}
    }
    process.exit(1);
  };
}

httpServer.on('error', onListenError('HTTPサーバー', HTTP_PORT));
httpServer.listen(HTTP_PORT, () => {
  console.log('\n╔═══════════════════════════════════════╗');
  console.log('║   🎬 Reaction Milestone Server v2     ║');
  console.log('╚═══════════════════════════════════════╝');
  console.log(`\n🖥  管理画面:         http://localhost:${HTTP_PORT}/admin.html`);
  console.log(`🎯 OBSオーバーレイ:  http://localhost:${HTTP_PORT}/overlay.html`);
  console.log(`🔌 WebSocket:        ws://localhost:${WS_PORT}`);
  console.log('\n管理画面でYouTube配信URLを入力して接続してください\n');
});

// ══════════════════════════════════════════
//  WebSocket サーバー（RFC 6455 手動実装）
// ══════════════════════════════════════════
const clients = new Map();
let clientIdCounter = 0;

const wsServer = net.createServer((socket) => {
  const id = ++clientIdCounter;
  let handshaked = false;
  let buf = Buffer.alloc(0);

  socket.on('data', (chunk) => {
    if (!handshaked) {
      const req = chunk.toString();
      const km  = req.match(/Sec-WebSocket-Key:\s*(.+)\r\n/i);
      if (!km) return socket.destroy();
      const om  = req.match(/\r\nOrigin:\s*(.+)\r\n/i);
      const hm  = req.match(/\r\nHost:\s*(.+)\r\n/i);
      if (!isAllowedOrigin({ headers: { origin: om?.[1].trim(), host: hm?.[1].trim() } })) {
        socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        return;
      }
      const accept = crypto.createHash('sha1')
        .update(km[1].trim() + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64');
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
      );
      handshaked = true;
      clients.set(id, socket);
      // 接続時に現在の状態を送信
      sendTo(socket, {
        type    : 'init',
        count   : totalCount,
        connected: ytState.connected,
        videoId : ytState.videoId,
        title   : ytState.title,
        channel : ytState.channel,
        viewers : ytState.viewers,
        sessionStart,
        achieved: [...achievedMilestones],
      });
      // OBSのキャッシュ更新などでoverlayがつなぎ直したときも、サウンド設定を引き継ぐ
      if (soundSettings) sendTo(socket, { type: 'volume_update', ...soundSettings });
      return;
    }

    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const opcode    = buf[0] & 0x0f;
      const masked    = (buf[1] & 0x80) !== 0;
      let payloadLen  = buf[1] & 0x7f;
      let offset      = 2;
      if (payloadLen === 126) { if (buf.length < 4) break; payloadLen = buf.readUInt16BE(2); offset = 4; }
      else if (payloadLen === 127) { if (buf.length < 10) break; payloadLen = Number(buf.readBigUInt64BE(2)); offset = 10; }
      const maskOffset = masked ? offset + 4 : offset;
      if (buf.length < maskOffset + payloadLen) break;
      if (opcode === 8) { socket.destroy(); break; }
      if (opcode === 9) { sendRaw(socket, Buffer.from([0x8a, 0x00])); }
      if (opcode === 1 || opcode === 2) {
        let payload = buf.slice(maskOffset, maskOffset + payloadLen);
        if (masked) { const mask = buf.slice(offset, offset + 4); for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]; }
        try { handleWsMessage(JSON.parse(payload.toString())); } catch (e) {}
      }
      buf = buf.slice(maskOffset + payloadLen);
    }
  });

  socket.on('close', () => clients.delete(id));
  socket.on('error', () => clients.delete(id));
});

wsServer.on('error', onListenError('WebSocketサーバー', WS_PORT));
wsServer.listen(WS_PORT);

function handleWsMessage(msg) {
  // WebSocket経由でもコマンドを受け付ける（管理画面からも使用）
  if (msg.type === 'add')    addCount(clampTestAmount(msg.amount));
  if (msg.type === 'reset')  resetAll();
}

function sendTo(socket, obj) {
  const payload = Buffer.from(JSON.stringify(obj));
  sendRaw(socket, Buffer.concat([buildFrameHeader(payload.length), payload]));
}

function broadcast(obj) {
  for (const [, socket] of clients) { try { sendTo(socket, obj); } catch (e) {} }
}

function buildFrameHeader(len) {
  if (len < 126)   return Buffer.from([0x81, len]);
  if (len < 65536) { const h = Buffer.alloc(4); h[0]=0x81; h[1]=126; h.writeUInt16BE(len,2); return h; }
  const h = Buffer.alloc(10); h[0]=0x81; h[1]=127; h.writeBigUInt64BE(BigInt(len),2); return h;
}

function sendRaw(socket, buf) { try { socket.write(buf); } catch (e) {} }

// ══════════════════════════════════════════
//  グレースフルシャットダウン
// ══════════════════════════════════════════
process.on('SIGINT', () => {
  console.log('\n\n👋 シャットダウンします...');
  disconnectYouTube();
  process.exit(0);
});
