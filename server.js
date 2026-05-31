import { Agent, Request as UndiciRequest, setGlobalDispatcher } from "undici";
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { loginWithPassword, loginWithQR, loginWithAuthToken } from "@evex/linejs";
import QRCode from "qrcode";
import path from "path";
import { fileURLToPath } from "url";
import { writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { AccountManager } from "./account-manager.js";

// web-push はオプショナル依存。未インストールでもアプリは起動できるよう動的import。
let webpush = null;
try {
  webpush = (await import("web-push")).default;
} catch {
  console.warn("[push] web-push not installed — PWA push disabled. Run `npm install` to enable.");
}

// LINE のプッシュ通知（メッセージ受信ポーリング）は HTTP/2 が必要
setGlobalDispatcher(new Agent({ allowH2: true }));
globalThis.Request = UndiciRequest;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const manager = new AccountManager();
const LINE_PROFILE_CDN = "https://profile.line-scdn.net";

// --- PWA Web Push ---
const PUSH_SUBSCRIPTIONS_PATH = "./push-subscriptions.json";
const VAPID_PATH = "./vapid.json";
let vapidKeys = null;
let pushSubscriptions = [];

function loadJsonFileSync(filePath, fallback) {
  try {
    if (existsSync(filePath)) return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch (e) {
    console.warn(`[push] failed to read ${filePath}:`, e.message);
  }
  return fallback;
}

async function saveJsonFile(filePath, data) {
  try {
    await writeFile(filePath, JSON.stringify(data), "utf-8");
  } catch (e) {
    console.warn(`[push] failed to write ${filePath}:`, e.message);
  }
}

function setupPush() {
  if (!webpush) return;
  vapidKeys = loadJsonFileSync(VAPID_PATH, null);
  if (!vapidKeys?.publicKey || !vapidKeys?.privateKey) {
    vapidKeys = webpush.generateVAPIDKeys();
    void saveJsonFile(VAPID_PATH, vapidKeys);
  }
  webpush.setVapidDetails("mailto:line-web-chat@example.com", vapidKeys.publicKey, vapidKeys.privateKey);
  const stored = loadJsonFileSync(PUSH_SUBSCRIPTIONS_PATH, []);
  pushSubscriptions = Array.isArray(stored) ? stored : [];
}
setupPush();

function getSubscriptionKey(sub) {
  return sub?.endpoint || "";
}

function addPushSubscription(sub) {
  if (!sub?.endpoint) return;
  const key = getSubscriptionKey(sub);
  if (!pushSubscriptions.some((s) => getSubscriptionKey(s) === key)) {
    pushSubscriptions.push(sub);
    void saveJsonFile(PUSH_SUBSCRIPTIONS_PATH, pushSubscriptions);
  }
}

function removePushSubscription(endpoint) {
  const before = pushSubscriptions.length;
  pushSubscriptions = pushSubscriptions.filter((s) => getSubscriptionKey(s) !== endpoint);
  if (pushSubscriptions.length !== before) {
    void saveJsonFile(PUSH_SUBSCRIPTIONS_PATH, pushSubscriptions);
  }
}

async function sendPushForMessage(session, chatMid, msg) {
  if (!webpush || pushSubscriptions.length === 0 || !chatMid) return;
  const senderName = session.contactNameCache.get(String(msg.from)) || "";
  const isGroup = String(chatMid).startsWith("c");
  const baseTitle = isGroup
    ? session.contactNameCache.get(chatMid) || "グループ"
    : senderName || "新着メッセージ";
  // 複数アカウント接続時はどのアカウント宛か分かるよう接頭辞を付ける
  const connectedCount = manager.list().filter((s) => s.connected).length;
  const accountLabel = connectedCount > 1 && session.meta.name ? `[${session.meta.name}] ` : "";
  const title = accountLabel + baseTitle;
  const bodyPrefix = isGroup && senderName ? senderName + ": " : "";
  const payload = JSON.stringify({
    title,
    body: bodyPrefix + (previewTextForMessage(msg) || "新しいメッセージ"),
    chatMid,
    accountId: session.id,
    tag: session.id + ":" + chatMid,
  });
  const dead = [];
  await Promise.all(
    pushSubscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(sub, payload);
      } catch (e) {
        if (e?.statusCode === 404 || e?.statusCode === 410) dead.push(getSubscriptionKey(sub));
      }
    }),
  );
  for (const endpoint of dead) removePushSubscription(endpoint);
}

// LINE OpType（オペレーション種別）の数値 -> 名前マッピング。
// polling のイベントは type が数値の場合と文字列名の場合の両方がありうるため正規化に使う。
const OP_TYPE_NAMES = {
  0: "END_OF_OPERATION", 1: "UPDATE_PROFILE", 2: "NOTIFIED_UPDATE_PROFILE",
  3: "REGISTER_USERID", 4: "ADD_CONTACT", 5: "NOTIFIED_ADD_CONTACT",
  6: "BLOCK_CONTACT", 7: "UNBLOCK_CONTACT", 8: "NOTIFIED_RECOMMEND_CONTACT",
  9: "CREATE_GROUP", 10: "UPDATE_GROUP", 11: "NOTIFIED_UPDATE_GROUP",
  12: "INVITE_INTO_GROUP", 13: "NOTIFIED_INVITE_INTO_GROUP", 14: "LEAVE_GROUP",
  15: "NOTIFIED_LEAVE_GROUP", 16: "ACCEPT_GROUP_INVITATION", 17: "NOTIFIED_ACCEPT_GROUP_INVITATION",
  18: "KICKOUT_FROM_GROUP", 19: "NOTIFIED_KICKOUT_FROM_GROUP", 20: "CREATE_ROOM",
  21: "INVITE_INTO_ROOM", 22: "NOTIFIED_INVITE_INTO_ROOM", 23: "LEAVE_ROOM",
  24: "NOTIFIED_LEAVE_ROOM", 25: "SEND_MESSAGE", 26: "RECEIVE_MESSAGE",
  27: "SEND_MESSAGE_RECEIPT", 28: "RECEIVE_MESSAGE_RECEIPT", 29: "SEND_CONTENT_RECEIPT",
  30: "RECEIVE_ANNOUNCEMENT", 31: "CANCEL_INVITATION_GROUP", 32: "NOTIFIED_CANCEL_INVITATION_GROUP",
  33: "NOTIFIED_UNREGISTER_USER", 34: "REJECT_GROUP_INVITATION", 35: "NOTIFIED_REJECT_GROUP_INVITATION",
  36: "UPDATE_SETTINGS", 37: "NOTIFIED_REGISTER_USER", 38: "INVITE_VIA_EMAIL",
  39: "NOTIFIED_REQUEST_RECOVERY", 40: "SEND_CHAT_CHECKED", 41: "SEND_CHAT_REMOVED",
  42: "NOTIFIED_FORCE_SYNC", 43: "SEND_CONTENT", 44: "SEND_MESSAGE_MYHOME",
  45: "NOTIFIED_UPDATE_CONTENT_PREVIEW", 46: "REMOVE_ALL_MESSAGES", 47: "NOTIFIED_UPDATE_PURCHASES",
  48: "DUMMY", 49: "UPDATE_CONTACT", 50: "NOTIFIED_RECEIVED_CALL", 51: "CANCEL_CALL",
  52: "NOTIFIED_REDIRECT", 53: "NOTIFIED_CHANNEL_SYNC", 54: "FAILED_SEND_MESSAGE",
  55: "NOTIFIED_READ_MESSAGE", 56: "FAILED_EMAIL_CONFIRMATION", 58: "NOTIFIED_CHAT_CONTENT",
  59: "NOTIFIED_PUSH_NOTICENTER_ITEM", 60: "NOTIFIED_JOIN_CHAT", 61: "NOTIFIED_LEAVE_CHAT",
  62: "NOTIFIED_TYPING", 63: "FRIEND_REQUEST_ACCEPTED", 64: "DESTROY_MESSAGE",
  65: "NOTIFIED_DESTROY_MESSAGE", 66: "UPDATE_PUBLICKEYCHAIN", 67: "NOTIFIED_UPDATE_PUBLICKEYCHAIN",
  68: "NOTIFIED_BLOCK_CONTACT", 69: "NOTIFIED_UNBLOCK_CONTACT", 70: "UPDATE_GROUPPREFERENCE",
  71: "NOTIFIED_PAYMENT_EVENT", 78: "NOTIFIED_BUDDY_UPDATE_PROFILE", 80: "UPDATE_ROOM",
  90: "NOTIFIED_POSTBACK", 91: "RECEIVE_READ_WATERMARK", 92: "NOTIFIED_MESSAGE_DELIVERED",
  93: "NOTIFIED_UPDATE_CHAT_BAR", 99: "NOTIFIED_UPDATE_MESSAGE", 100: "UPDATE_CHATROOMBGM",
  101: "NOTIFIED_UPDATE_CHATROOMBGM", 102: "UPDATE_RINGTONE", 118: "UPDATE_USER_SETTINGS",
  119: "NOTIFIED_UPDATE_STATUS_BAR", 120: "CREATE_CHAT", 121: "UPDATE_CHAT",
  122: "NOTIFIED_UPDATE_CHAT", 123: "INVITE_INTO_CHAT", 124: "NOTIFIED_INVITE_INTO_CHAT",
  125: "CANCEL_CHAT_INVITATION", 126: "NOTIFIED_CANCEL_CHAT_INVITATION", 127: "DELETE_SELF_FROM_CHAT",
  128: "NOTIFIED_DELETE_SELF_FROM_CHAT", 129: "ACCEPT_CHAT_INVITATION", 130: "NOTIFIED_ACCEPT_CHAT_INVITATION",
  131: "REJECT_CHAT_INVITATION", 132: "DELETE_OTHER_FROM_CHAT", 133: "NOTIFIED_DELETE_OTHER_FROM_CHAT",
  137: "SEND_CHAT_HIDDEN", 139: "SEND_REACTION", 140: "NOTIFIED_SEND_REACTION",
  141: "NOTIFIED_UPDATE_PROFILE_CONTENT", 142: "FAILED_DELIVERY_MESSAGE",
  158: "EDIT_MESSAGE", 159: "NOTIFIED_EDIT_MESSAGE",
};

function getOpName(event) {
  const t = event?.type;
  if (typeof t === "number") return OP_TYPE_NAMES[t] || String(t);
  return String(t ?? "");
}

const RAW_MSG_CACHE_MAX = 500;
const MEDIA_MIME_BY_EXT = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
  ".webm": "video/webm",
  ".3gp": "video/3gpp",
  ".3g2": "video/3gpp2",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
};

// Cache raw (pre-decryption) media messages so we can download E2EE media later
function cacheRawMessage(session, msg) {
  if (!msg?.id) return;
  const id = String(msg.id);
  const cache = session.rawMessageCache;
  if (cache.size >= RAW_MSG_CACHE_MAX) {
    cache.delete(cache.keys().next().value);
  }
  cache.set(id, msg);
}

function normalizeContentType(contentType) {
  if (typeof contentType === "number") return String(contentType);
  if (typeof contentType === "string") return contentType.toUpperCase();
  return "";
}

function isImageContentType(contentType) {
  const normalized = normalizeContentType(contentType);
  return normalized === "1" || normalized === "IMAGE";
}

function isVideoContentType(contentType) {
  const normalized = normalizeContentType(contentType);
  return normalized === "2" || normalized === "VIDEO";
}

function isAudioContentType(contentType) {
  const normalized = normalizeContentType(contentType);
  return normalized === "3" || normalized === "AUDIO";
}

function isFileContentType(contentType) {
  const normalized = normalizeContentType(contentType);
  return normalized === "14" || normalized === "FILE";
}

function shouldCacheRawMediaMessage(msg) {
  if (!msg || typeof msg !== "object") return false;
  return isImageContentType(msg.contentType)
    || isVideoContentType(msg.contentType)
    || isAudioContentType(msg.contentType)
    || isFileContentType(msg.contentType);
}

function guessMediaMimeType(fileName, fallback = "application/octet-stream") {
  const ext = path.extname(String(fileName || "")).toLowerCase();
  return MEDIA_MIME_BY_EXT[ext] || fallback;
}

function getHeaderValue(header) {
  if (Array.isArray(header)) return header[0];
  return header;
}

function parseVideoDurationMs(headerValue) {
  const rawValue = getHeaderValue(headerValue);
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) return 1919;
  return Math.max(1, Math.round(parsed));
}

function parseByteRange(rangeHeader, totalLength) {
  if (!rangeHeader || typeof rangeHeader !== "string") return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
  if (!match) return null;

  const [, startRaw, endRaw] = match;
  let start;
  let end;

  if (startRaw === "" && endRaw === "") return "invalid";

  if (startRaw === "") {
    const suffixLength = Number(endRaw);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return "invalid";
    start = Math.max(totalLength - Math.floor(suffixLength), 0);
    end = totalLength - 1;
  } else {
    start = Number(startRaw);
    end = endRaw ? Number(endRaw) : totalLength - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end)) return "invalid";
  }

  if (start < 0 || end < start || start >= totalLength) return "invalid";
  end = Math.min(end, totalLength - 1);
  return { start, end };
}

async function sendBlobWithRangeSupport(req, res, file, fallbackMimeType) {
  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const totalLength = buffer.length;
  const contentType = file.type || fallbackMimeType;
  const rangeInfo = parseByteRange(req.headers.range, totalLength);

  res.set("Content-Type", contentType);
  res.set("Cache-Control", "public, max-age=3600");
  res.set("Accept-Ranges", "bytes");

  if (rangeInfo === "invalid") {
    res.set("Content-Range", `bytes */${totalLength}`);
    return res.status(416).end();
  }

  if (!rangeInfo) {
    res.set("Content-Length", String(totalLength));
    return res.send(buffer);
  }

  const { start, end } = rangeInfo;
  const chunk = buffer.subarray(start, end + 1);
  res.status(206);
  res.set("Content-Range", `bytes ${start}-${end}/${totalLength}`);
  res.set("Content-Length", String(chunk.length));
  return res.send(chunk);
}

function getMessageSenderMid(msg) {
  return String(msg?._from ?? msg?.from ?? "");
}

function normalizeE2EEMessage(rawMsg) {
  if (!rawMsg || typeof rawMsg !== "object") return rawMsg;
  const normalized = { ...rawMsg };

  if (!normalized.from && normalized._from) {
    normalized.from = normalized._from;
  }
  if (!normalized._from && normalized.from) {
    normalized._from = normalized.from;
  }
  if (!normalized.toType && typeof normalized.to === "string") {
    if (normalized.to.startsWith("u")) normalized.toType = "USER";
    else if (normalized.to.startsWith("c")) normalized.toType = "GROUP";
  }
  return normalized;
}

function buildE2EEMessageCandidates(rawMsg, ownMid) {
  const base = normalizeE2EEMessage(rawMsg);
  const candidates = [base];

  if (ownMid && base?.to && String(base.to) !== ownMid) {
    candidates.push({ ...base, to: ownMid });
  }

  const seen = new Set();
  return candidates.filter((msg) => {
    const key = JSON.stringify([
      msg?.id ?? "",
      msg?.from ?? "",
      msg?._from ?? "",
      msg?.to ?? "",
      msg?.toType ?? "",
    ]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function decryptE2EEDataPayload(session, rawMsg, decryptFn) {
  const client = session.client;
  if (!client) throw new Error("Not authenticated");
  const ownMid = String(client.base.profile?.mid ?? "");
  const decryptMessage = decryptFn ?? client.base.e2ee.decryptE2EEDataMessage.bind(client.base.e2ee);
  const candidates = buildE2EEMessageCandidates(rawMsg, ownMid);
  let lastError = null;

  for (const candidate of candidates) {
    const senderMid = getMessageSenderMid(candidate);
    const primaryIsSelf = ownMid && senderMid ? senderMid === ownMid : true;
    const attempts = [...new Set([primaryIsSelf, !primaryIsSelf])];

    for (const isSelf of attempts) {
      try {
        const payload = await decryptMessage(candidate, isSelf);
        if (payload?.keyMaterial) {
          return payload;
        }
        throw new Error("E2EE payload missing keyMaterial");
      } catch (e) {
        lastError = e;
      }
    }
  }

  throw lastError ?? new Error("Failed to decrypt E2EE metadata payload");
}

async function downloadMediaByE2EESmart(session, rawMsg) {
  const client = session.client;
  if (!client) throw new Error("Not authenticated");
  const normalized = normalizeE2EEMessage(rawMsg);
  const obs = client.base.obs;
  const e2ee = client.base.e2ee;
  const originalDecrypt = e2ee.decryptE2EEDataMessage.bind(e2ee);

  const patchedE2EE = Object.create(e2ee);
  patchedE2EE.decryptE2EEDataMessage = async (msg) => {
    return await decryptE2EEDataPayload(session, msg, originalDecrypt);
  };

  const patchedClient = Object.create(obs.client);
  patchedClient.e2ee = patchedE2EE;

  const patchedObs = Object.create(obs);
  patchedObs.client = patchedClient;

  return await obs.downloadMediaByE2EE.call(patchedObs, normalized);
}

async function downloadMessageMedia(session, { messageId, isPreview, rawMsg, fallbackMimeType, logPrefix }) {
  const client = session.client;
  if (!client) throw new Error("Not authenticated");
  const isE2EEMedia = !!rawMsg?.chunks?.length;
  let file = null;

  if (isE2EEMedia) {
    try {
      file = await downloadMediaByE2EESmart(session, rawMsg);
    } catch (e) {
      console.error(`[${logPrefix}] E2EE smart download failed:`, e.message);
    }
    if (!file) {
      try {
        const encryptedBlob = await client.base.obs.downloadMessageData({ messageId, isPreview });
        const e2eePayload = await decryptE2EEDataPayload(session, rawMsg);
        const decryptedBuffer = await client.base.e2ee.decryptByKeyMaterial(
          Buffer.from(await encryptedBlob.arrayBuffer()),
          e2eePayload.keyMaterial,
        );
        file = new Blob(
          [decryptedBuffer],
          {
            type: guessMediaMimeType(
              e2eePayload.fileName,
              encryptedBlob.type || fallbackMimeType,
            ),
          },
        );
      } catch (e) {
        console.error(`[${logPrefix}] E2EE fallback decrypt failed:`, e.message);
      }
    }
  } else {
    file = await client.base.obs.downloadMessageData({ messageId, isPreview });
  }

  return file;
}

const TALK_POLLING_INTERVAL_MS = 1200;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function abortPushConnections(client) {
  for (const conn of client?.base?.push?.conns ?? []) {
    try { conn.reqStream?.abort?.abort(); } catch {}
  }
}

function stopPolling(session) {
  if (!session.pollingAbortController) return;
  session.pollingAbortController.abort();
  session.pollingAbortController = null;
}

function patchSafeNoop(client) {
  const talk = client?.base?.talk;
  if (!talk || talk.__safeNoopPatched) return;

  const originalNoop = talk.noop.bind(talk);
  talk.noop = async (...args) => {
    try {
      return await originalNoop(...args);
    } catch (e) {
      const message = e?.message ?? "";
      // Keep push alive when LINE returns an empty noop payload.
      if (message.includes("Request internal failed: Invalid response buffer")) {
        console.warn("[push] noop failed, ignored:", message);
        return;
      }
      throw e;
    }
  };
  talk.__safeNoopPatched = true;
}

// 全ソケットへ accountId 付きでイベントを送る（フロントが表示中アカウントを判定するため）
function emitAccount(session, event, payload) {
  if (payload && typeof payload === "object") {
    io.emit(event, { ...payload, accountId: session.id });
  } else {
    io.emit(event, payload);
  }
}

function broadcastAccounts() {
  io.emit("accounts:update", { accounts: manager.list().map((s) => s.toPublic()) });
}

// --- Helpers ---

function assertClient(session) {
  if (!session?.client) throw new Error("Not authenticated");
}

// エラーをcauseチェーンまで含めて文字列化する（"fetch failed" の真因を見るため）
function describeError(e, depth = 0) {
  if (!e || depth > 5) return String(e);
  const parts = [];
  const name = e.name ? `${e.name}: ` : "";
  parts.push(`${name}${e.message ?? String(e)}`);
  if (e.code) parts.push(`(code=${e.code})`);
  if (e.errno != null) parts.push(`(errno=${e.errno})`);
  if (e.cause) parts.push(`\n    caused by → ${describeError(e.cause, depth + 1)}`);
  return parts.join(" ");
}

function logAuthError(label, e) {
  console.error(`[auth:${label}] login failed: ${describeError(e)}`);
  if (e?.stack) console.error(e.stack);
}

// 認証済みセッションを要求するルート用。未解決/未ログインなら適切なエラーを返す。
function getAuthedSession(req, res) {
  const session = req.acct;
  if (!session) {
    res.status(404).json({ error: "account not found" });
    return null;
  }
  if (!session.client) {
    res.status(401).json({ error: "Not authenticated" });
    return null;
  }
  return session;
}

// talk.getContacts returns Contact objects directly
function formatContact(contact) {
  const pictureStatus = contact.pictureStatus ?? "";
  return {
    mid: contact.mid,
    name: contact.displayName ?? contact.mid,
    statusMessage: contact.statusMessage ?? "",
    avatarUrl: pictureStatus ? LINE_PROFILE_CDN + "/" + pictureStatus : null,
  };
}

function formatMessage(msg) {
  const metadata = msg?.contentMetadata && typeof msg.contentMetadata === "object"
    ? Object.fromEntries(
      Object.entries(msg.contentMetadata).map(([k, v]) => [k, v == null ? "" : String(v)]),
    )
    : {};
  const loc = msg?.location;
  const location = loc
    ? {
        title: loc.title ? String(loc.title) : "",
        address: loc.address ? String(loc.address) : "",
        latitude: loc.latitude != null ? Number(loc.latitude) : null,
        longitude: loc.longitude != null ? Number(loc.longitude) : null,
      }
    : null;
  return {
    id: msg.id?.toString() ?? "",
    from: msg._from?.toString() ?? msg.from?.toString() ?? "",
    to: msg.to?.toString() ?? "",
    text: msg.text ?? "",
    contentType: msg.contentType ?? "NONE",
    contentMetadata: metadata,
    location,
    createdTime: msg.createdTime ? Number(msg.createdTime) : Date.now(),
    relatedMessageId: msg.relatedMessageId ? msg.relatedMessageId.toString() : undefined,
  };
}

function getChatMidFromMessage(msg, myMid) {
  const to = msg.to ? String(msg.to) : "";
  const from = msg.from ? String(msg.from) : "";
  if (to.startsWith("c")) return to;
  const isOutgoing = myMid && from === String(myMid);
  return isOutgoing ? to : from;
}

function toEpochMs(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : 0;
  if (typeof value === "bigint") return value > 0n ? Number(value) : 0;

  const parsed = Number(typeof value === "string" ? value : value.toString?.() ?? value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

// getMessageBoxes は重く、レートリミットの原因になりやすい。
// 友だち一覧・グループ一覧・メッセージ取得で個別に呼ぶと起動時に何度も叩いてしまうため、
// 短時間（既定3秒）のキャッシュをセッション単位で共有し、同時呼び出しは1つのリクエストにまとめる。
const MESSAGE_BOXES_TTL_MS = 3000;

function invalidateMessageBoxesCache(session) {
  session.messageBoxesCache = { promise: null, time: 0 };
}

async function fetchMessageBoxes(session) {
  // 未読数と最新メッセージ付きで取得。サーバーがこのリクエスト形を拒否した場合は最小形でリトライ。
  try {
    return await session.client.base.talk.getMessageBoxes({
      messageBoxListRequest: {
        withUnreadCount: true,
        lastMessagesPerMessageBoxCount: 1,
      },
    });
  } catch (e) {
    console.warn("[boxes] extended request failed, retrying minimal:", e.message);
    return await session.client.base.talk.getMessageBoxes({ messageBoxListRequest: {} });
  }
}

async function getMessageBoxesCached(session, force = false) {
  assertClient(session);
  const now = Date.now();
  const cache = session.messageBoxesCache;
  if (!force && cache.promise && now - cache.time < MESSAGE_BOXES_TTL_MS) {
    return cache.promise;
  }
  const promise = fetchMessageBoxes(session).catch((e) => {
    // 失敗したキャッシュは残さない
    if (session.messageBoxesCache.promise === promise) invalidateMessageBoxesCache(session);
    throw e;
  });
  session.messageBoxesCache = { promise, time: now };
  return promise;
}

// メッセージのプレビュー用テキスト（チャット一覧の最新メッセージ表示）。
function previewTextForMessage(msg) {
  if (!msg) return "";
  const meta = msg.contentMetadata || {};
  if (meta.UNSENT === "true") return "メッセージの送信を取り消しました";
  if (isImageContentType(msg.contentType)) return "[画像]";
  if (isVideoContentType(msg.contentType)) return "[動画]";
  if (isAudioContentType(msg.contentType)) return "[ボイスメッセージ]";
  if (isFileContentType(msg.contentType)) return "[ファイル]";
  const ct = normalizeContentType(msg.contentType);
  if (ct === "7" || ct === "STICKER") return "[スタンプ]";
  if (ct === "15" || ct === "LOCATION") return "[位置情報]";
  if (ct === "18" || ct === "CHATEVENT") return msg.text ? String(msg.text) : "";
  if (msg.text) return String(msg.text);
  return "";
}

// 各チャットの最新メッセージ時刻・未読数・プレビューテキストを構築する。
// プレビューは E2EE（1対1）の暗号化テキストを大量復号しないよう、
// 復号済みでDBに保存済みのメッセージを優先し、無ければボックスの内容種別ラベルを使う。
async function buildChatMetaByMid(session) {
  const boxes = await getMessageBoxesCached(session);
  const metaByMid = new Map();
  for (const box of boxes?.messageBoxes ?? []) {
    const mid = box?.id ? String(box.id) : "";
    if (!mid) continue;

    const lastMessageTime = toEpochMs(box?.lastDeliveredMessageId?.deliveredTime);
    const unreadCount = Number(box?.unreadCount ?? 0) || 0;

    const boxLast = Array.isArray(box?.lastMessages) && box.lastMessages.length > 0
      ? formatMessage(box.lastMessages[0])
      : null;
    const dbLatest = session.messageStore.getLatestMessage(mid);

    let previewMsg = null;
    if (boxLast && dbLatest && String(boxLast.id) === String(dbLatest.id)) {
      previewMsg = dbLatest; // 同一メッセージなら復号済みのDB版を使う
    } else if (boxLast && dbLatest) {
      previewMsg = toEpochMs(boxLast.createdTime) > toEpochMs(dbLatest.createdTime) ? boxLast : dbLatest;
    } else {
      previewMsg = dbLatest || boxLast;
    }

    metaByMid.set(mid, {
      lastMessageTime: lastMessageTime || toEpochMs(previewMsg?.createdTime),
      unreadCount,
      preview: previewTextForMessage(previewMsg),
    });
  }
  return metaByMid;
}

// --- 表示名の解決（システムメッセージ用） ---

function setContactName(session, mid, name) {
  if (mid && name) session.contactNameCache.set(String(mid), String(name));
}

async function resolveNames(session, mids) {
  const result = new Map();
  const missing = [];
  for (const raw of mids) {
    const mid = String(raw || "");
    if (!mid) continue;
    if (session.contactNameCache.has(mid)) {
      result.set(mid, session.contactNameCache.get(mid));
    } else if (!missing.includes(mid)) {
      missing.push(mid);
    }
  }
  if (missing.length > 0 && session.client) {
    try {
      const contacts = await session.client.base.talk.getContacts({ mids: missing });
      for (const c of contacts ?? []) {
        const mid = String(c?.mid ?? "");
        const name = c?.displayName ?? mid;
        if (mid) {
          setContactName(session, mid, name);
          result.set(mid, name);
        }
      }
    } catch (e) {
      console.warn("[system-msg] resolveNames failed:", e.message);
    }
  }
  return result;
}

function sortByLastMessageTimeDesc(chats) {
  chats.sort((a, b) => {
    const timeDiff = (b.lastMessageTime ?? 0) - (a.lastMessageTime ?? 0);
    if (timeDiff !== 0) return timeDiff;
    return String(a.name ?? "").localeCompare(String(b.name ?? ""), "ja");
  });
}

// --- アカウント解決ミドルウェア ---
// X-Account-Id ヘッダ、または ?account= クエリで対象セッションを解決する。
app.use("/api", (req, _res, next) => {
  const id = req.get("X-Account-Id") || req.query.account;
  req.acct = manager.get(id);
  next();
});

// --- REST API ---

// アカウント一覧
app.get("/api/accounts", (_req, res) => {
  res.json({ accounts: manager.list().map((s) => s.toPublic()) });
});

// Auth status（互換用: アカウントの有無/接続状態を返す）
app.get("/api/auth/status", (req, res) => {
  const accounts = manager.list().map((s) => s.toPublic());
  const session = req.acct;
  res.json({
    authenticated: !!session?.client,
    hasStoredToken: accounts.length > 0,
    accounts,
  });
});

// --- PWA Push 購読 ---
app.get("/api/push/public-key", (_req, res) => {
  if (!webpush || !vapidKeys) return res.status(503).json({ error: "push unavailable" });
  res.json({ publicKey: vapidKeys.publicKey });
});

app.post("/api/push/subscribe", (req, res) => {
  if (!webpush) return res.status(503).json({ error: "push unavailable" });
  const sub = req.body?.subscription || req.body;
  addPushSubscription(sub);
  res.json({ success: true });
});

app.post("/api/push/unsubscribe", (req, res) => {
  const endpoint = req.body?.endpoint || req.body?.subscription?.endpoint;
  if (endpoint) removePushSubscription(endpoint);
  res.json({ success: true });
});

// Logout（指定アカウントを切断して登録簿から削除）
app.post("/api/auth/logout", async (req, res) => {
  try {
    const session = req.acct;
    if (session) {
      teardownSession(session);
      await manager.remove(session);
      broadcastAccounts();
    }
    res.json({ success: true, accounts: manager.list().map((s) => s.toPublic()) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Own profile (MID)
app.get("/api/profile", (req, res) => {
  try {
    const session = getAuthedSession(req, res);
    if (!session) return;
    res.json({
      mid: session.client.base.profile?.mid ?? session.meta.mid ?? null,
      name: session.meta.name || "",
      avatarUrl: session.meta.avatarUrl || null,
      accountId: session.id,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Groups list
app.get("/api/groups", async (req, res) => {
  try {
    const session = getAuthedSession(req, res);
    if (!session) return;
    const result = await session.client.base.talk.getAllChatMids({
      syncReason: "INTERNAL",
      request: { withMemberChats: true, withInvitedChats: false },
    });
    const chatMids = result?.memberChatMids ?? [];
    const groupMids = chatMids.filter((mid) => String(mid).startsWith("c"));
    if (groupMids.length === 0) return res.json({ groups: [] });
    const metaByMid = await buildChatMetaByMid(session);

    const chunkSize = 50;
    const groups = [];
    for (let i = 0; i < groupMids.length; i += chunkSize) {
      const chunk = groupMids.slice(i, i + chunkSize);
      const raw = await session.client.base.talk.getChats({ chatMids: chunk });
      for (const chat of raw?.chats ?? []) {
        const picturePath = chat.picturePath ?? "";
        const mid = String(chat.chatMid ?? "");
        const meta = metaByMid.get(mid);
        setContactName(session, mid, chat.chatName ?? mid);
        groups.push({
          mid,
          name: chat.chatName ?? mid,
          avatarUrl: picturePath ? LINE_PROFILE_CDN + picturePath : null,
          memberCount: chat.memberCount ?? 0,
          lastMessageTime: meta?.lastMessageTime ?? 0,
          unreadCount: meta?.unreadCount ?? 0,
          preview: meta?.preview ?? "",
        });
      }
    }
    sortByLastMessageTimeDesc(groups);
    res.json({ groups });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Friends list
app.get("/api/friends", async (req, res) => {
  try {
    const session = getAuthedSession(req, res);
    if (!session) return;
    const result = await session.client.base.relation.getUserFriendIds({
      request: { blockStatus: "ALL" },
    });
    const mids = result?.userFriendMids ?? [];
    if (mids.length === 0) return res.json({ friends: [] });
    const metaByMid = await buildChatMetaByMid(session);

    // Use talk.getContacts which works for this account type
    const chunkSize = 50;
    const contacts = [];
    for (let i = 0; i < mids.length; i += chunkSize) {
      const chunk = mids.slice(i, i + chunkSize);
      const raw = await session.client.base.talk.getContacts({ mids: chunk });
      for (const c of raw ?? []) {
        const contact = formatContact(c);
        setContactName(session, contact.mid, contact.name);
        const meta = metaByMid.get(String(contact.mid));
        contact.lastMessageTime = meta?.lastMessageTime ?? 0;
        contact.unreadCount = meta?.unreadCount ?? 0;
        contact.preview = meta?.preview ?? "";
        contacts.push(contact);
      }
    }
    sortByLastMessageTimeDesc(contacts);
    res.json({ friends: contacts });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// LINE API からメッセージを取得してDBに保存し、フォーマット済みメッセージを返す
async function fetchAndStoreMessages(session, mid, box, limit, beforeMessageId, beforeDeliveredTime) {
  let endMessageIdCandidates;
  if (beforeMessageId && beforeDeliveredTime) {
    // ページネーション: クライアントが指定した最古メッセージIDを使用
    const bId = BigInt(beforeMessageId);
    const bTime = Number(beforeDeliveredTime);
    endMessageIdCandidates = [
      { messageId: bId, deliveredTime: bTime },
      { messageId: Number(beforeMessageId), deliveredTime: bTime },
      { messageId: bId + 1n, deliveredTime: bTime + 1 },
    ];
  } else {
    // 初回ロード: LINE の getPreviousMessagesV2WithRequest は endMessageId の型（BigInt vs Number）
    // によって一部のチャットBOXで 0 件を返すことがある。
    // Number(messageId)+1 が最も多くのBOXで成功するが、精度ロスで逆に取得できなくなる
    // BOXもあるため、複数の方式をフォールバックで試行する。
    if (!box.lastDeliveredMessageId?.messageId) {
      return { messages: [], hasMore: false };
    }
    const msgId = box.lastDeliveredMessageId.messageId;
    const deliveredTime = box.lastDeliveredMessageId.deliveredTime;
    endMessageIdCandidates = [
      // Strategy 1: Number(bigint)+1 — 精度ロスで丸められたIDが多くのBOXでヒットする
      { messageId: Number(msgId) + 1, deliveredTime: Number(deliveredTime) + 1 },
      // Strategy 2: 元の BigInt 値（一部のBOXではこれが正しい）
      { messageId: msgId, deliveredTime },
      // Strategy 3: BigInt + 1n（endMessageId が排他的な場合のフォールバック）
      {
        messageId: typeof msgId === "bigint" ? msgId + 1n : msgId + 1,
        deliveredTime: typeof deliveredTime === "bigint" ? deliveredTime + 1n : deliveredTime + 1,
      },
    ];
  }

  let raw = null;
  for (const endMessageId of endMessageIdCandidates) {
    try {
      const result = await session.client.base.talk.getPreviousMessagesV2WithRequest({
        request: {
          messageBoxId: box.id,
          endMessageId,
          messagesCount: limit,
        },
      });
      if ((result ?? []).length > 0) {
        raw = result;
        break;
      }
      if (!raw) raw = result;
    } catch {
      // 型エラー等は無視して次を試行
    }
  }

  // E2EE メッセージを復号する（media メッセージは復号前にキャッシュ）
  const decrypted = await Promise.all(
    (raw ?? []).map(async (msg) => {
      if (shouldCacheRawMediaMessage(msg)) {
        cacheRawMessage(session, msg);
      }
      if (msg.contentMetadata?.e2eeVersion) {
        try {
          return await session.client.base.e2ee.decryptE2EEMessage(msg);
        } catch {
          return msg;
        }
      }
      return msg;
    }),
  );

  const messages = decrypted
    .map(formatMessage)
    .sort((a, b) => toEpochMs(a.createdTime) - toEpochMs(b.createdTime));

  if (messages.length > 0) {
    session.messageStore.saveBatch(mid, messages);
  }

  return { messages, hasMore: (raw ?? []).length === limit };
}

// Get messages for a chat (user or group mid)
app.get("/api/chat/:mid/messages", async (req, res) => {
  try {
    const session = getAuthedSession(req, res);
    if (!session) return;
    const { mid } = req.params;
    const limit = Math.min(Number(req.query.limit ?? 30), 100);
    const beforeMessageId = req.query.beforeMessageId;
    const beforeDeliveredTime = req.query.beforeDeliveredTime;

    // ページネーション: DBに該当範囲のメッセージがあればそれを返す（古いメッセージはDB優先）
    if (beforeMessageId && beforeDeliveredTime) {
      const cached = session.messageStore.getMessages(mid, {
        limit,
        beforeCreatedTime: Number(beforeDeliveredTime),
        beforeId: beforeMessageId,
      });
      if (cached.messages.length > 0) {
        return res.json(cached);
      }
    }

    // LINE API からメッセージボックスを取得（初回・キャッシュ鮮度確認のため。短時間キャッシュを共有）
    const boxes = await getMessageBoxesCached(session);
    const box = boxes?.messageBoxes?.find((b) => String(b.id) === mid);
    if (!box) return res.json({ messages: [], hasMore: false });

    // 初回読み込み: DBの最新メッセージがLINEの最新と一致していればDBを返す
    if (!beforeMessageId && session.messageStore.hasMessages(mid)) {
      const boxLastTime = toEpochMs(box?.lastDeliveredMessageId?.deliveredTime);
      const dbLatestTime = session.messageStore.getLatestCreatedTime(mid);
      if (!boxLastTime || dbLatestTime >= boxLastTime - 2000) {
        const cached = session.messageStore.getMessages(mid, { limit });
        return res.json(cached);
      }
    }

    const result = await fetchAndStoreMessages(session, mid, box, limit, beforeMessageId, beforeDeliveredTime);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Download image
app.get("/api/message/:messageId/image", async (req, res) => {
  try {
    const session = getAuthedSession(req, res);
    if (!session) return;
    const { messageId } = req.params;
    const isPreview = req.query.preview === "1";
    const rawMsg = session.rawMessageCache.get(messageId);
    const file = await downloadMessageMedia(session, {
      messageId,
      isPreview,
      rawMsg,
      fallbackMimeType: "image/jpeg",
      logPrefix: "image",
    });

    if (!file) return res.status(404).json({ error: "Image not found" });
    await sendBlobWithRangeSupport(req, res, file, "image/jpeg");
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Download video
app.get("/api/message/:messageId/video", async (req, res) => {
  try {
    const session = getAuthedSession(req, res);
    if (!session) return;
    const { messageId } = req.params;
    const isPreview = req.query.preview === "1";
    const rawMsg = session.rawMessageCache.get(messageId);
    const file = await downloadMessageMedia(session, {
      messageId,
      isPreview,
      rawMsg,
      fallbackMimeType: "video/mp4",
      logPrefix: "video",
    });

    if (!file) return res.status(404).json({ error: "Video not found" });
    await sendBlobWithRangeSupport(req, res, file, "video/mp4");
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Download audio
app.get("/api/message/:messageId/audio", async (req, res) => {
  try {
    const session = getAuthedSession(req, res);
    if (!session) return;
    const { messageId } = req.params;
    const rawMsg = session.rawMessageCache.get(messageId);
    const file = await downloadMessageMedia(session, {
      messageId,
      isPreview: false,
      rawMsg,
      fallbackMimeType: "audio/mp4",
      logPrefix: "audio",
    });
    if (!file) return res.status(404).json({ error: "Audio not found" });
    await sendBlobWithRangeSupport(req, res, file, file.type || "audio/mp4");
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Download file
app.get("/api/message/:messageId/file", async (req, res) => {
  try {
    const session = getAuthedSession(req, res);
    if (!session) return;
    const { messageId } = req.params;
    const rawMsg = session.rawMessageCache.get(messageId);
    const file = await downloadMessageMedia(session, {
      messageId,
      isPreview: false,
      rawMsg,
      fallbackMimeType: "application/octet-stream",
      logPrefix: "file",
    });
    if (!file) return res.status(404).json({ error: "File not found" });
    const fileName = req.query.name ? String(req.query.name) : "file";
    res.set("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    await sendBlobWithRangeSupport(req, res, file, file.type || "application/octet-stream");
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Send image
app.post(
  "/api/chat/:mid/send-image",
  express.raw({ type: "*/*", limit: "10mb" }),
  async (req, res) => {
    try {
      const session = getAuthedSession(req, res);
      if (!session) return;
      const { mid } = req.params;
      const mimeType = String(getHeaderValue(req.headers["content-type"]) || "image/jpeg")
        .split(";")[0]
        .trim();
      const blob = new Blob([req.body], { type: mimeType });
      let sentMessage = null;

      if (mid.startsWith("u")) {
        // 1対1チャット: E2EE
        sentMessage = await session.client.base.obs.uploadMediaByE2EE({
          data: blob,
          to: mid,
          oType: "image",
          filename: "image.jpg",
        });
      } else {
        // グループチャット: 非E2EE
        const { objId } = await session.client.base.obs.uploadObjTalk(mid, "image", blob);
        sentMessage = await session.client.base.talk.sendMessage({
          to: mid,
          contentType: 1,
          contentMetadata: { OID: objId },
        });
      }

      if (sentMessage) cacheRawMessage(session, sentMessage);
      res.json({
        success: true,
        message: sentMessage ? formatMessage(sentMessage) : null,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  },
);

// Send video
app.post(
  "/api/chat/:mid/send-video",
  express.raw({ type: "*/*", limit: "100mb" }),
  async (req, res) => {
    try {
      const session = getAuthedSession(req, res);
      if (!session) return;
      const { mid } = req.params;
      if (!req.body?.length) {
        return res.status(400).json({ error: "video body required" });
      }

      const mimeType = String(getHeaderValue(req.headers["content-type"]) || "video/mp4")
        .split(";")[0]
        .trim();
      const durationMs = parseVideoDurationMs(req.headers["x-video-duration-ms"]);
      const blob = new Blob([req.body], { type: mimeType });
      let sentMessage = null;

      if (mid.startsWith("u")) {
        // 1対1チャット: E2EE
        sentMessage = await session.client.base.obs.uploadMediaByE2EE({
          data: blob,
          to: mid,
          oType: "video",
          filename: "video.mp4",
        });
      } else {
        // グループチャット: 非E2EE
        const { objId, objHash } = await session.client.base.obs.uploadObjTalk(mid, "video", blob);
        sentMessage = await session.client.base.talk.sendMessage({
          to: mid,
          contentType: 2,
          contentMetadata: {
            OID: objId,
            VID: objId,
            DURATION: String(durationMs),
            SIZE: String(blob.size),
            HASH: objHash,
          },
        });
      }

      if (sentMessage) cacheRawMessage(session, sentMessage);
      res.json({
        success: true,
        message: sentMessage ? formatMessage(sentMessage) : null,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  },
);

// Send file (any type, contentType 14)
app.post(
  "/api/chat/:mid/send-file",
  express.raw({ type: "*/*", limit: "300mb" }),
  async (req, res) => {
    try {
      const session = getAuthedSession(req, res);
      if (!session) return;
      const { mid } = req.params;
      if (!req.body?.length) {
        return res.status(400).json({ error: "file body required" });
      }
      const mimeType = String(getHeaderValue(req.headers["content-type"]) || "application/octet-stream")
        .split(";")[0]
        .trim();
      const rawName = getHeaderValue(req.headers["x-file-name"]);
      let fileName = "file";
      try {
        fileName = rawName ? decodeURIComponent(rawName) : "file";
      } catch {
        fileName = String(rawName || "file");
      }
      const blob = new Blob([req.body], { type: mimeType });
      let sentMessage = null;

      if (mid.startsWith("u")) {
        // 1対1チャット: E2EE（メッセージ送信まで自動で行われる）
        sentMessage = await session.client.base.obs.uploadMediaByE2EE({
          data: blob,
          to: mid,
          oType: "file",
          filename: fileName,
        });
      } else {
        // グループ/チャット: 非E2EE
        const { objId } = await session.client.base.obs.uploadObjTalk(mid, "file", blob);
        sentMessage = await session.client.base.talk.sendMessage({
          to: mid,
          contentType: 14,
          contentMetadata: {
            OID: objId,
            FILE_NAME: fileName,
            FILE_SIZE: String(blob.size),
          },
        });
      }

      if (sentMessage) {
        cacheRawMessage(session, sentMessage);
        // E2EE 経由だと FILE_NAME がメタデータに含まれないことがあるので補完
        if (sentMessage.contentMetadata && !sentMessage.contentMetadata.FILE_NAME) {
          sentMessage.contentMetadata.FILE_NAME = fileName;
        }
      }
      res.json({
        success: true,
        message: sentMessage ? formatMessage(sentMessage) : null,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  },
);

// Send message
app.post("/api/chat/:mid/send", async (req, res) => {
  try {
    const session = getAuthedSession(req, res);
    if (!session) return;
    const { mid } = req.params;
    const { text, relatedMessageId } = req.body;
    if (!text?.trim()) return res.status(400).json({ error: "text required" });

    const sendOpts = {
      to: mid,
      text: text.trim(),
      contentType: "NONE",
      contentMetadata: {},
    };
    if (relatedMessageId) sendOpts.relatedMessageId = String(relatedMessageId);

    const sentMessage = await session.client.base.talk.sendMessage(sendOpts);
    res.json({ success: true, message: sentMessage ? formatMessage(sentMessage) : null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 送信取り消し
app.post("/api/message/:messageId/unsend", async (req, res) => {
  try {
    const session = getAuthedSession(req, res);
    if (!session) return;
    const { messageId } = req.params;
    await session.client.base.talk.unsendMessage({ messageId, seq: 0 });
    session.messageStore.markAsUnsent(messageId);
    emitAccount(session, "chat:unsend", { messageId });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 既読を送信する（自分がチャットを開いた/メッセージを読んだことを相手に通知）
app.post("/api/chat/:mid/read", async (req, res) => {
  try {
    const session = getAuthedSession(req, res);
    if (!session) return;
    const { mid } = req.params;
    const { lastMessageId } = req.body || {};
    if (!lastMessageId) return res.status(400).json({ error: "lastMessageId required" });
    const seq = await session.client.base.getReqseq();
    await session.client.base.talk.sendChatChecked({
      chatMid: mid,
      lastMessageId: String(lastMessageId),
      seq,
    });
    // 既読を送ると未読数が変わるためボックスキャッシュを無効化
    invalidateMessageBoxesCache(session);
    res.json({ success: true });
  } catch (e) {
    console.error("[read] error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// 既読情報取得
app.get("/api/chat/:mid/read-status", async (req, res) => {
  try {
    const session = getAuthedSession(req, res);
    if (!session) return;
    const { mid } = req.params;
    const result = await session.client.base.talk.getMessageReadRange({
      chatIds: [mid],
    });
    // BigInt を Number/String に変換してシリアライズ可能にする
    const sanitized = JSON.parse(
      JSON.stringify(result ?? [], (k, v) => typeof v === "bigint" ? Number(v) : v),
    );
    res.json({ readRanges: sanitized });
  } catch (e) {
    console.error("[read-status] error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// グループメンバー一覧取得
app.get("/api/chat/:mid/members", async (req, res) => {
  try {
    const session = getAuthedSession(req, res);
    if (!session) return;
    const { mid } = req.params;
    if (!mid.startsWith("c")) {
      return res.status(400).json({ error: "Not a group chat" });
    }
    const chatResult = await session.client.base.talk.getChat({
      chatMid: mid,
      withMembers: true,
    });
    const memberMids = chatResult?.memberMids ?? [];
    const members = [];
    if (memberMids.length > 0) {
      const chunkSize = 50;
      for (let i = 0; i < memberMids.length; i += chunkSize) {
        const chunk = memberMids.slice(i, i + chunkSize);
        const contacts = await session.client.base.talk.getContacts({ mids: chunk });
        for (const c of contacts ?? []) {
          const formatted = formatContact(c);
          setContactName(session, formatted.mid, formatted.name);
          members.push(formatted);
        }
      }
    }
    res.json({ members });
  } catch (e) {
    console.error("[members] error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// --- システムメッセージ / オペレーションイベント処理 ---

// param3 に複数MIDが入る場合の区切り（カンマまたは RS 制御文字）
const MID_SEPARATOR = /[,]/;

function splitMids(value) {
  if (!value) return [];
  return String(value).split(MID_SEPARATOR).map((s) => s.trim()).filter(Boolean);
}

function nameOrSelf(mid, names, myMid) {
  if (!mid) return "";
  if (myMid && String(mid) === String(myMid)) return "あなた";
  return names.get(String(mid)) || (String(mid).slice(0, 6) + "…");
}

function joinNames(mids, names, myMid) {
  return mids.map((m) => nameOrSelf(m, names, myMid)).filter(Boolean).join("、");
}

// op に応じてシステムメッセージのテキストを生成。表示対象外の op なら null を返す。
async function buildSystemMessageText(session, opName, event, myMid) {
  const actorMid = event?.param2 ? String(event.param2) : "";
  const targetMids = splitMids(event?.param3);
  const involved = [actorMid, ...targetMids].filter(Boolean);
  const names = involved.length > 0 ? await resolveNames(session, involved) : new Map();
  const actor = nameOrSelf(actorMid, names, myMid);
  const targets = joinNames(targetMids, names, myMid);

  switch (opName) {
    case "NOTIFIED_INVITE_INTO_GROUP":
    case "INVITE_INTO_GROUP":
    case "NOTIFIED_INVITE_INTO_CHAT":
    case "INVITE_INTO_CHAT":
    case "NOTIFIED_INVITE_INTO_ROOM":
    case "INVITE_INTO_ROOM":
      return targets ? `${actor}が${targets}を招待しました` : `${actor}がメンバーを招待しました`;
    case "NOTIFIED_ACCEPT_GROUP_INVITATION":
    case "ACCEPT_GROUP_INVITATION":
    case "NOTIFIED_ACCEPT_CHAT_INVITATION":
    case "ACCEPT_CHAT_INVITATION":
    case "NOTIFIED_JOIN_CHAT":
      return `${actor}が参加しました`;
    case "NOTIFIED_LEAVE_GROUP":
    case "LEAVE_GROUP":
    case "NOTIFIED_LEAVE_ROOM":
    case "LEAVE_ROOM":
    case "NOTIFIED_LEAVE_CHAT":
    case "NOTIFIED_DELETE_SELF_FROM_CHAT":
    case "DELETE_SELF_FROM_CHAT":
      return `${actor}が退出しました`;
    case "NOTIFIED_KICKOUT_FROM_GROUP":
    case "KICKOUT_FROM_GROUP":
    case "NOTIFIED_DELETE_OTHER_FROM_CHAT":
    case "DELETE_OTHER_FROM_CHAT":
      return targets ? `${actor}が${targets}を退会させました` : `${actor}がメンバーを退会させました`;
    case "NOTIFIED_CANCEL_INVITATION_GROUP":
    case "CANCEL_INVITATION_GROUP":
    case "NOTIFIED_CANCEL_CHAT_INVITATION":
    case "CANCEL_CHAT_INVITATION":
      return targets ? `${actor}が${targets}の招待を取り消しました` : `${actor}が招待を取り消しました`;
    case "NOTIFIED_REJECT_GROUP_INVITATION":
    case "REJECT_GROUP_INVITATION":
    case "REJECT_CHAT_INVITATION":
      return `${actor}が招待を辞退しました`;
    case "NOTIFIED_UPDATE_GROUP":
    case "UPDATE_GROUP":
    case "NOTIFIED_UPDATE_CHAT":
    case "UPDATE_CHAT":
      return `${actor}がグループ情報を変更しました`;
    case "CREATE_GROUP":
    case "CREATE_CHAT":
      return `${actor}がグループを作成しました`;
    default:
      return null;
  }
}

function emitSystemMessage(session, chatMid, opName, event, text) {
  const createdTime = toEpochMs(event?.createdTime) || Date.now();
  const actorMid = event?.param2 ? String(event.param2) : "";
  const msg = {
    id: `sys-${chatMid}-${createdTime}-${opName}`,
    from: actorMid,
    to: chatMid,
    text,
    contentType: "CHATEVENT",
    contentMetadata: {
      SYSEVENT: opName,
      ACTOR: actorMid,
      TARGETS: splitMids(event?.param3).join(","),
    },
    location: null,
    createdTime,
    system: true,
  };
  try {
    session.messageStore.save(chatMid, msg);
  } catch (e) {
    console.warn("[system-msg] save failed:", e.message);
  }
  emitAccount(session, "chat:message", msg);
}

// SEND_MESSAGE / RECEIVE_MESSAGE 以外の全オペレーションを処理する。
async function handleTalkOperation(session, event, opName) {
  const client = session.client;
  const myMid = String(client.base.profile?.mid ?? "");

  // 既読通知（相手が自分のメッセージを読んだ）
  if (opName === "NOTIFIED_READ_MESSAGE") {
    const readerMid = event.param1 ? String(event.param1) : "";
    const chatMid = event.param2 ? String(event.param2) : "";
    if (readerMid && chatMid) emitAccount(session, "chat:read", { readerMid, chatMid });
    return;
  }
  // 自分が既読を送った
  if (opName === "SEND_CHAT_CHECKED") {
    const chatMid = event.param1 ? String(event.param1) : "";
    if (chatMid) {
      invalidateMessageBoxesCache(session);
      emitAccount(session, "chat:read", { readerMid: myMid, chatMid });
    }
    return;
  }
  // 送信取り消し
  if (opName === "DESTROY_MESSAGE" || opName === "NOTIFIED_DESTROY_MESSAGE") {
    const messageId = event.param2 ? String(event.param2) : "";
    if (messageId) {
      session.messageStore.markAsUnsent(messageId);
      emitAccount(session, "chat:unsend", { messageId });
    }
    return;
  }
  // 入力中（タイピング）
  if (opName === "NOTIFIED_TYPING") {
    const chatMid = event.param1 ? String(event.param1) : "";
    const typerMid = event.param2 ? String(event.param2) : "";
    if (chatMid && typerMid && typerMid !== myMid) {
      emitAccount(session, "chat:typing", { chatMid, mid: typerMid });
    }
    return;
  }
  // メッセージ編集
  if (opName === "EDIT_MESSAGE" || opName === "NOTIFIED_EDIT_MESSAGE") {
    let msg = event.message;
    if (!msg) return;
    try {
      msg = await client.base.e2ee.decryptE2EEMessage(msg);
    } catch {}
    const formatted = formatMessage(msg);
    formatted.edited = true;
    const chatMid = getChatMidFromMessage(formatted, myMid);
    if (chatMid) session.messageStore.save(chatMid, formatted);
    emitAccount(session, "chat:message-edited", formatted);
    return;
  }
  // リアクション（パラメータ仕様が環境依存のためベストエフォートで生値を渡す）
  if (opName === "SEND_REACTION" || opName === "NOTIFIED_SEND_REACTION") {
    const chatMid = event.param1 ? String(event.param1) : "";
    const messageId = event.param2 ? String(event.param2) : "";
    const reactionType = event.param7 != null ? String(event.param7)
      : event.reactionType != null ? String(event.reactionType) : "";
    if (chatMid && messageId) emitAccount(session, "chat:reaction", { chatMid, messageId, reactionType });
    return;
  }

  // メンバー参加/退出・グループ更新などはチャット内システムメッセージとして表示
  const systemText = await buildSystemMessageText(session, opName, event, myMid);
  if (systemText) {
    // 通常 param1 がグループ/チャットmidだが、念のため c/r 始まりのparamを優先採用
    const candidates = [event.param1, event.param2, event.param3].map((v) => (v ? String(v) : ""));
    const chatMid = candidates.find((v) => v && (v.charAt(0) === "c" || v.charAt(0) === "r"))
      || candidates[0]
      || "";
    if (chatMid) {
      emitSystemMessage(session, chatMid, opName, event, systemText);
      invalidateMessageBoxesCache(session);
    }
  }
}

// --- ポーリング（メッセージ受信ループ） ---

// listen() が E2EE エラーや接続切断で終了した場合に自動再起動するポーリングループ
async function listenWithRestart(session, client, signal) {
  while (!signal.aborted && session.client === client) {
    try {
      const polling = client.base.createPolling();
      const supportsPollingFallback = typeof polling._listenTalkEvents === "function";
      const events = supportsPollingFallback
        ? polling._listenTalkEvents({
          signal,
          pollingInterval: TALK_POLLING_INTERVAL_MS,
          onError(error) {
            console.error("[polling] sync error:", error?.message ?? String(error));
          },
        })
        : polling.listenTalkEvents();

      for await (const event of events) {
        if (signal.aborted || session.client !== client) break;
        const opName = getOpName(event);
        if (opName === "SEND_MESSAGE" || opName === "RECEIVE_MESSAGE") {
          let msg = event.message;
          // media メッセージは復号前にキャッシュ（E2EEメディアダウンロード用）
          if (shouldCacheRawMediaMessage(msg)) {
            cacheRawMessage(session, msg);
          }
          try {
            msg = await client.base.e2ee.decryptE2EEMessage(msg);
          } catch (e) {
            console.error("[E2EE] decrypt error (skipping message):", e.message);
          }
          const formatted = formatMessage(msg);
          const myMid = String(client.base.profile?.mid ?? "");
          const chatMid = getChatMidFromMessage(formatted, myMid);
          if (chatMid) session.messageStore.save(chatMid, formatted);
          // 受信したメッセージは未読数が変化するのでボックスキャッシュを無効化
          invalidateMessageBoxesCache(session);
          emitAccount(session, "chat:message", formatted);
          // 自分以外からの新着はPWA Pushで通知
          if (opName === "RECEIVE_MESSAGE" && formatted.from && formatted.from !== myMid) {
            void sendPushForMessage(session, chatMid, formatted);
          }
        } else {
          try {
            await handleTalkOperation(session, event, opName);
          } catch (e) {
            console.error(`[op:${opName}] handler error:`, e.message);
          }
        }
      }
      if (signal.aborted || session.client !== client) break;
      console.log("[polling] talk stream ended — restarting");
    } catch (e) {
      if (signal.aborted || session.client !== client) break;
      console.error("[polling] error:", e.message, "— restarting in 2s");
      await sleep(2000);
    }
  }
}

function setupClientListeners(session) {
  const client = session.client;
  if (!client) return;
  // update:authtoken is emitted on base, not on the Client wrapper
  client.base.on("update:authtoken", async (token) => {
    await session.storage.set(".auth", token);
  });

  const controller = new AbortController();
  session.pollingAbortController = controller;
  void listenWithRestart(session, client, controller.signal);
}

// --- セッションのアクティブ化 / 破棄 ---

// ログイン済みクライアントをセッションへ取り付け、メタ情報を更新してポーリングを開始する。
async function activateClient(session, client) {
  session.client = client;
  patchSafeNoop(client);
  const profile = client.base.profile;
  const mid = String(profile?.mid ?? session.meta.mid ?? "");
  const name = profile?.displayName || session.meta.name || "";
  const pictureStatus = profile?.pictureStatus ?? "";
  const avatarUrl = pictureStatus
    ? LINE_PROFILE_CDN + "/" + pictureStatus
    : (session.meta.avatarUrl || null);
  await manager.updateMeta(session, { mid, name, avatarUrl });
  setupClientListeners(session);
  broadcastAccounts();
}

function teardownSession(session) {
  stopPolling(session);
  if (session.client) {
    abortPushConnections(session.client);
    // update:authtoken リスナーを除去して、トークン再書き込みを防ぐ
    session.client.base.removeAllListeners?.("update:authtoken");
    session.client.base.authToken = undefined;
  }
  session.client = null;
  session.contactNameCache.clear();
  session.rawMessageCache.clear();
  invalidateMessageBoxesCache(session);
}

// 新規ログイン成功後、同一MIDの既存アカウントがあれば古い方を破棄して重複を防ぐ。
async function dedupeByMid(session) {
  const mid = String(session.meta.mid || "");
  if (!mid) return;
  const existing = manager.findByMid(mid);
  if (existing && existing.id !== session.id) {
    teardownSession(existing);
    await manager.remove(existing);
  }
}

// 起動時、登録済みアカウントを保存トークンで順に復元する（バーストを避けるため間隔を空ける）。
async function restoreSession(session) {
  if (session.client || session.authInProgress) return;
  session.authInProgress = true;
  try {
    const token = await session.storage.get(".auth");
    if (!token) return;
    const client = await loginWithAuthToken(token, {
      device: "DESKTOPWIN",
      storage: session.storage,
      fetch: session.fetch,
    });
    await activateClient(session, client);
    console.log(`[accounts] restored ${session.meta.name || session.id}`);
  } catch (e) {
    console.warn(`[accounts] restore failed for ${session.id}: ${describeError(e)}`);
  } finally {
    session.authInProgress = false;
  }
}

async function restoreAllSessions() {
  const legacy = await manager.migrateLegacyIfNeeded();
  if (legacy) console.log("[accounts] legacy data migrated to account", legacy.id);
  const sessions = manager.list();
  for (let i = 0; i < sessions.length; i += 1) {
    if (i > 0) await sleep(400); // 起動時バーストを緩和
    void restoreSession(sessions[i]);
  }
}

// --- Socket.io (auth flows + real-time messages) ---

io.on("connection", (socket) => {
  // 接続時にアカウント一覧を返す
  socket.on("accounts:list", () => {
    socket.emit("accounts:update", { accounts: manager.list().map((s) => s.toPublic()) });
  });

  // 互換: 旧フロントが auth:auto を送ってくる場合はアカウント一覧で応答
  socket.on("auth:auto", () => {
    const accounts = manager.list().map((s) => s.toPublic());
    if (accounts.length === 0) {
      socket.emit("auth:none");
    } else {
      socket.emit("accounts:update", { accounts });
    }
  });

  // Login with email + password（新規アカウント追加）
  socket.on("auth:password", async ({ email, password }) => {
    if (!email || !password) {
      return socket.emit("auth:error", { error: "email and password required" });
    }
    const session = manager.createSession();
    session.authInProgress = true;
    try {
      const client = await loginWithPassword(
        {
          email,
          password,
          onPincodeRequest(pincode) {
            socket.emit("auth:pincode", { pincode });
          },
        },
        { device: "DESKTOPWIN", storage: session.storage, fetch: session.fetch },
      );
      await activateClient(session, client);
      // Explicitly persist the access token after login
      if (client.authToken) await session.storage.set(".auth", client.authToken);
      await dedupeByMid(session);
      broadcastAccounts();
      socket.emit("auth:success", { method: "password", account: session.toPublic() });
    } catch (e) {
      logAuthError("password", e);
      // 失敗したセッションは空なので登録簿から取り除く
      teardownSession(session);
      await manager.remove(session);
      socket.emit("auth:error", { error: describeError(e) });
    } finally {
      session.authInProgress = false;
    }
  });

  // Login with QR code（新規アカウント追加）
  socket.on("auth:qr", async () => {
    const session = manager.createSession();
    session.authInProgress = true;
    try {
      const client = await loginWithQR(
        {
          async onReceiveQRUrl(url) {
            const dataUrl = await QRCode.toDataURL(url, { width: 256 });
            socket.emit("auth:qrcode", { url, dataUrl });
          },
          onPincodeRequest(pincode) {
            socket.emit("auth:pincode", { pincode });
          },
        },
        { device: "DESKTOPWIN", storage: session.storage, fetch: session.fetch },
      );
      await activateClient(session, client);
      // Explicitly persist the access token after login
      if (client.authToken) await session.storage.set(".auth", client.authToken);
      await dedupeByMid(session);
      broadcastAccounts();
      socket.emit("auth:success", { method: "qr", account: session.toPublic() });
    } catch (e) {
      logAuthError("qr", e);
      teardownSession(session);
      await manager.remove(session);
      socket.emit("auth:error", { error: describeError(e) });
    } finally {
      session.authInProgress = false;
    }
  });
});

// --- Start ---

const PORT = process.env.PORT ?? 3000;
httpServer.listen(PORT, () => {
  console.log(`LINE Web Chat running at http://localhost:${PORT}`);
  void restoreAllSessions();
});
