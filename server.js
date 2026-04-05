import { Agent, fetch as undiciFetch, Request as UndiciRequest, setGlobalDispatcher } from "undici";
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { loginWithPassword, loginWithQR, loginWithAuthToken } from "@evex/linejs";
import QRCode from "qrcode";
import path from "path";
import { fileURLToPath } from "url";
import { writeFile } from "fs/promises";
import { SafeJsonFileStorage } from "./safe-storage.js";

// LINE のプッシュ通知（メッセージ受信ポーリング）は HTTP/2 が必要
setGlobalDispatcher(new Agent({ allowH2: true }));
globalThis.Request = UndiciRequest;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

let storage = new SafeJsonFileStorage("./line-storage.json");
const LINE_PROFILE_CDN = "https://profile.line-scdn.net";

// Cache raw (pre-decryption) media messages so we can download E2EE media later
const rawMessageCache = new Map();
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

function cacheRawMessage(msg) {
  if (!msg?.id) return;
  const id = String(msg.id);
  if (rawMessageCache.size >= RAW_MSG_CACHE_MAX) {
    rawMessageCache.delete(rawMessageCache.keys().next().value);
  }
  rawMessageCache.set(id, msg);
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

function shouldCacheRawMediaMessage(msg) {
  if (!msg || typeof msg !== "object") return false;
  return isImageContentType(msg.contentType) || isVideoContentType(msg.contentType);
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

async function decryptE2EEDataPayload(rawMsg, decryptFn) {
  if (!lineClient) throw new Error("Not authenticated");
  const ownMid = String(lineClient.base.profile?.mid ?? "");
  const decryptMessage = decryptFn ?? lineClient.base.e2ee.decryptE2EEDataMessage.bind(lineClient.base.e2ee);
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

async function downloadMediaByE2EESmart(rawMsg) {
  if (!lineClient) throw new Error("Not authenticated");
  const normalized = normalizeE2EEMessage(rawMsg);
  const obs = lineClient.base.obs;
  const e2ee = lineClient.base.e2ee;
  const originalDecrypt = e2ee.decryptE2EEDataMessage.bind(e2ee);

  const patchedE2EE = Object.create(e2ee);
  patchedE2EE.decryptE2EEDataMessage = async (msg) => {
    return await decryptE2EEDataPayload(msg, originalDecrypt);
  };

  const patchedClient = Object.create(obs.client);
  patchedClient.e2ee = patchedE2EE;

  const patchedObs = Object.create(obs);
  patchedObs.client = patchedClient;

  return await obs.downloadMediaByE2EE.call(patchedObs, normalized);
}

async function downloadMessageMedia({ messageId, isPreview, rawMsg, fallbackMimeType, logPrefix }) {
  if (!lineClient) throw new Error("Not authenticated");
  const isE2EEMedia = !!rawMsg?.chunks?.length;
  let file = null;

  if (isE2EEMedia) {
    try {
      file = await downloadMediaByE2EESmart(rawMsg);
    } catch (e) {
      console.error(`[${logPrefix}] E2EE smart download failed:`, e.message);
    }
    if (!file) {
      try {
        const encryptedBlob = await lineClient.base.obs.downloadMessageData({ messageId, isPreview });
        const e2eePayload = await decryptE2EEDataPayload(rawMsg);
        const decryptedBuffer = await lineClient.base.e2ee.decryptByKeyMaterial(
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
    file = await lineClient.base.obs.downloadMessageData({ messageId, isPreview });
  }

  return file;
}

/** @type {import("@evex/linejs").Client | null} */
let lineClient = null;
let talkPollingAbortController = null;
const TALK_POLLING_INTERVAL_MS = 1200;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function abortPushConnections(client) {
  for (const conn of client?.base?.push?.conns ?? []) {
    try { conn.reqStream?.abort?.abort(); } catch {}
  }
}

function stopTalkPolling() {
  if (!talkPollingAbortController) return;
  talkPollingAbortController.abort();
  talkPollingAbortController = null;
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

function installClient(client) {
  if (lineClient && lineClient !== client) {
    abortPushConnections(lineClient);
  }
  stopTalkPolling();
  lineClient = client;
  patchSafeNoop(client);
  setupClientListeners();
}

// --- Helpers ---

function assertClient() {
  if (!lineClient) throw new Error("Not authenticated");
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
  return {
    id: msg.id?.toString() ?? "",
    from: msg._from?.toString() ?? msg.from?.toString() ?? "",
    to: msg.to?.toString() ?? "",
    text: msg.text ?? "",
    contentType: msg.contentType ?? "NONE",
    contentMetadata: metadata,
    createdTime: msg.createdTime ? Number(msg.createdTime) : Date.now(),
  };
}

function toEpochMs(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : 0;
  if (typeof value === "bigint") return value > 0n ? Number(value) : 0;

  const parsed = Number(typeof value === "string" ? value : value.toString?.() ?? value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

async function getLastMessageTimeByMid() {
  const boxes = await lineClient.base.talk.getMessageBoxes({
    messageBoxListRequest: {},
  });
  const lastMessageTimeByMid = new Map();
  for (const box of boxes?.messageBoxes ?? []) {
    const mid = box?.id ? String(box.id) : "";
    if (!mid) continue;
    const deliveredTime = toEpochMs(box?.lastDeliveredMessageId?.deliveredTime);
    lastMessageTimeByMid.set(mid, deliveredTime);
  }
  return lastMessageTimeByMid;
}

function sortByLastMessageTimeDesc(chats) {
  chats.sort((a, b) => {
    const timeDiff = (b.lastMessageTime ?? 0) - (a.lastMessageTime ?? 0);
    if (timeDiff !== 0) return timeDiff;
    return String(a.name ?? "").localeCompare(String(b.name ?? ""), "ja");
  });
}

// --- REST API ---

// Auth status
app.get("/api/auth/status", async (_req, res) => {
  try {
    const token = await storage.get(".auth");
    res.json({ authenticated: !!lineClient, hasStoredToken: !!token });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Logout
app.post("/api/auth/logout", async (_req, res) => {
  try {
    if (lineClient) {
      // Abort active push (HTTP/2) connections and stop polling loop
      stopTalkPolling();
      abortPushConnections(lineClient);
      lineClient.base.authToken = undefined;
      lineClient = null;
    }
    // Reset the global HTTP/2 agent so the next login gets fresh connections
    setGlobalDispatcher(new Agent({ allowH2: true }));
    await writeFile("./line-storage.json", "{}");
    storage = new SafeJsonFileStorage("./line-storage.json");
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Login with stored token
app.post("/api/auth/token", async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: "token required" });
  try {
    const client = await loginWithAuthToken(token, {
      device: "DESKTOPWIN",
      storage,
      fetch: undiciFetch,
    });
    installClient(client);
    res.json({ success: true });
  } catch (e) {
    lineClient = null;
    stopTalkPolling();
    res.status(401).json({ error: e.message });
  }
});

// Own profile (MID)
app.get("/api/profile", (_req, res) => {
  try {
    assertClient();
    res.json({ mid: lineClient.base.profile?.mid ?? null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Groups list
app.get("/api/groups", async (_req, res) => {
  try {
    assertClient();
    const result = await lineClient.base.talk.getAllChatMids({
      syncReason: "INTERNAL",
      request: { withMemberChats: true, withInvitedChats: false },
    });
    const chatMids = result?.memberChatMids ?? [];
    const groupMids = chatMids.filter((mid) => String(mid).startsWith("c"));
    if (groupMids.length === 0) return res.json({ groups: [] });
    const lastMessageTimeByMid = await getLastMessageTimeByMid();

    const chunkSize = 50;
    const groups = [];
    for (let i = 0; i < groupMids.length; i += chunkSize) {
      const chunk = groupMids.slice(i, i + chunkSize);
      const raw = await lineClient.base.talk.getChats({ chatMids: chunk });
      for (const chat of raw?.chats ?? []) {
        const picturePath = chat.picturePath ?? "";
        const mid = String(chat.chatMid ?? "");
        groups.push({
          mid,
          name: chat.chatName ?? mid,
          avatarUrl: picturePath ? LINE_PROFILE_CDN + picturePath : null,
          memberCount: chat.memberCount ?? 0,
          lastMessageTime: lastMessageTimeByMid.get(mid) ?? 0,
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
app.get("/api/friends", async (_req, res) => {
  try {
    assertClient();
    const result = await lineClient.base.relation.getUserFriendIds({
      request: { blockStatus: "ALL" },
    });
    const mids = result?.userFriendMids ?? [];
    if (mids.length === 0) return res.json({ friends: [] });
    const lastMessageTimeByMid = await getLastMessageTimeByMid();

    // Use talk.getContacts which works for this account type
    const chunkSize = 50;
    const contacts = [];
    for (let i = 0; i < mids.length; i += chunkSize) {
      const chunk = mids.slice(i, i + chunkSize);
      const raw = await lineClient.base.talk.getContacts({ mids: chunk });
      for (const c of raw ?? []) {
        const contact = formatContact(c);
        contact.lastMessageTime = lastMessageTimeByMid.get(String(contact.mid)) ?? 0;
        contacts.push(contact);
      }
    }
    sortByLastMessageTimeDesc(contacts);
    res.json({ friends: contacts });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get messages for a chat (user or group mid)
app.get("/api/chat/:mid/messages", async (req, res) => {
  try {
    assertClient();
    const { mid } = req.params;
    const limit = Math.min(Number(req.query.limit ?? 30), 100);

    const boxes = await lineClient.base.talk.getMessageBoxes({
      messageBoxListRequest: {},
    });
    const box = boxes?.messageBoxes?.find((b) => b.id === mid);
    if (!box) return res.json({ messages: [] });

    // LINE の getPreviousMessagesV2WithRequest は endMessageId の型（BigInt vs Number）
    // によって一部のチャットBOXで 0 件を返すことがある。
    // Number(messageId)+1 が最も多くのBOXで成功するが、精度ロスで逆に取得できなくなる
    // BOXもあるため、複数の方式をフォールバックで試行する。
    const msgId = box.lastDeliveredMessageId.messageId;
    const deliveredTime = box.lastDeliveredMessageId.deliveredTime;

    const endMessageIdCandidates = [
      // Strategy 1: Number(bigint)+1 — 精度ロスで丸められたIDが多くのBOXでヒットする
      { messageId: Number(msgId) + 1, deliveredTime: Number(deliveredTime) + 1 },
      // Strategy 2: 元の BigInt 値（一部のBOXではこれが正しい）
      { messageId: msgId, deliveredTime },
      // Strategy 3: BigInt + 1n（endMessageId が排他的な場合のフォールバック）
      { messageId: typeof msgId === "bigint" ? msgId + 1n : msgId + 1, deliveredTime: deliveredTime + 1 },
    ];

    let raw = null;
    for (const endMessageId of endMessageIdCandidates) {
      try {
        const result = await lineClient.base.talk.getPreviousMessagesV2WithRequest({
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
        // 最初の試行結果を保持（全て 0 件の場合に使用）
        if (!raw) raw = result;
      } catch {
        // 型エラー等は無視して次を試行
      }
    }

    // E2EE メッセージを復号する（media メッセージは復号前にキャッシュ）
    const decrypted = await Promise.all(
      (raw ?? []).map(async (msg) => {
        if (shouldCacheRawMediaMessage(msg)) {
          cacheRawMessage(msg);
        }
        if (msg.contentMetadata?.e2eeVersion) {
          try {
            return await lineClient.base.e2ee.decryptE2EEMessage(msg);
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
    res.json({ messages });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Download image
app.get("/api/message/:messageId/image", async (req, res) => {
  try {
    assertClient();
    const { messageId } = req.params;
    const isPreview = req.query.preview === "1";
    const rawMsg = rawMessageCache.get(messageId);
    const file = await downloadMessageMedia({
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
    assertClient();
    const { messageId } = req.params;
    const isPreview = req.query.preview === "1";
    const rawMsg = rawMessageCache.get(messageId);
    const file = await downloadMessageMedia({
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

// Send image
app.post(
  "/api/chat/:mid/send-image",
  express.raw({ type: "*/*", limit: "10mb" }),
  async (req, res) => {
    try {
      assertClient();
      const { mid } = req.params;
      const mimeType = String(getHeaderValue(req.headers["content-type"]) || "image/jpeg")
        .split(";")[0]
        .trim();
      const blob = new Blob([req.body], { type: mimeType });
      let sentMessage = null;

      if (mid.startsWith("u")) {
        // 1対1チャット: E2EE
        sentMessage = await lineClient.base.obs.uploadMediaByE2EE({
          data: blob,
          to: mid,
          oType: "image",
          filename: "image.jpg",
        });
      } else {
        // グループチャット: 非E2EE
        const { objId } = await lineClient.base.obs.uploadObjTalk(mid, "image", blob);
        sentMessage = await lineClient.base.talk.sendMessage({
          to: mid,
          contentType: 1,
          contentMetadata: { OID: objId },
        });
      }

      if (sentMessage) cacheRawMessage(sentMessage);
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
      assertClient();
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
        sentMessage = await lineClient.base.obs.uploadMediaByE2EE({
          data: blob,
          to: mid,
          oType: "video",
          filename: "video.mp4",
        });
      } else {
        // グループチャット: 非E2EE
        const { objId, objHash } = await lineClient.base.obs.uploadObjTalk(mid, "video", blob);
        sentMessage = await lineClient.base.talk.sendMessage({
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

      if (sentMessage) cacheRawMessage(sentMessage);
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
    assertClient();
    const { mid } = req.params;
    const { text } = req.body;
    if (!text?.trim()) return res.status(400).json({ error: "text required" });

    await lineClient.base.talk.sendMessage({
      to: mid,
      text: text.trim(),
      contentType: "NONE",
      contentMetadata: {},
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 既読情報取得
app.get("/api/chat/:mid/read-status", async (req, res) => {
  try {
    assertClient();
    const { mid } = req.params;
    const result = await lineClient.base.talk.getMessageReadRange({
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
    assertClient();
    const { mid } = req.params;
    if (!mid.startsWith("c")) {
      return res.status(400).json({ error: "Not a group chat" });
    }
    const chatResult = await lineClient.base.talk.getChat({
      chatMid: mid,
      withMembers: true,
    });
    const memberMids = chatResult?.memberMids ?? [];
    const members = [];
    if (memberMids.length > 0) {
      const chunkSize = 50;
      for (let i = 0; i < memberMids.length; i += chunkSize) {
        const chunk = memberMids.slice(i, i + chunkSize);
        const contacts = await lineClient.base.talk.getContacts({ mids: chunk });
        for (const c of contacts ?? []) {
          members.push(formatContact(c));
        }
      }
    }
    res.json({ members });
  } catch (e) {
    console.error("[members] error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// --- Socket.io (auth flows + real-time messages) ---

// listen() が E2EE エラーや接続切断で終了した場合に自動再起動するポーリングループ
async function listenWithRestart(client, signal) {
  while (!signal.aborted && lineClient === client) {
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
        if (signal.aborted || lineClient !== client) break;
        if (event.type === "SEND_MESSAGE" || event.type === "RECEIVE_MESSAGE") {
          let msg = event.message;
          // media メッセージは復号前にキャッシュ（E2EEメディアダウンロード用）
          if (shouldCacheRawMediaMessage(msg)) {
            cacheRawMessage(msg);
          }
          try {
            msg = await client.base.e2ee.decryptE2EEMessage(msg);
          } catch (e) {
            console.error("[E2EE] decrypt error (skipping message):", e.message);
          }
          io.emit("chat:message", formatMessage(msg));
        }
        // 既読通知イベント
        if (event.type === "NOTIFIED_READ_MESSAGE" || event.type === 55) {
          // param1 = 読んだ人のMID, param2 = チャットのMID
          const readerMid = event.param1 ? String(event.param1) : "";
          const chatMid = event.param2 ? String(event.param2) : "";
          if (readerMid && chatMid) {
            io.emit("chat:read", { readerMid, chatMid });
          }
        }
        // 自分が既読を送った場合 (SEND_CHAT_CHECKED / 40)
        if (event.type === "SEND_CHAT_CHECKED" || event.type === 40) {
          const chatMid = event.param1 ? String(event.param1) : "";
          if (chatMid) {
            io.emit("chat:read", { readerMid: String(client.base.profile?.mid ?? ""), chatMid });
          }
        }
      }
      if (signal.aborted || lineClient !== client) break;
      console.log("[polling] talk stream ended — restarting");
    } catch (e) {
      if (signal.aborted || lineClient !== client) break;
      console.error("[polling] error:", e.message, "— restarting in 2s");
      await sleep(2000);
    }
  }
}

function setupClientListeners() {
  if (!lineClient) return;
  // update:authtoken is emitted on base, not on the Client wrapper
  lineClient.base.on("update:authtoken", async (token) => {
    await storage.set(".auth", token);
  });

  const controller = new AbortController();
  talkPollingAbortController = controller;
  void listenWithRestart(lineClient, controller.signal);
}

io.on("connection", (socket) => {
  // Auto-login with stored token on connect
  socket.on("auth:auto", async () => {
    if (lineClient) {
      socket.emit("auth:success", { method: "cached" });
      return;
    }
    try {
      const token = await storage.get(".auth");
      if (!token) return socket.emit("auth:none");
      const client = await loginWithAuthToken(token, { device: "DESKTOPWIN", storage, fetch: undiciFetch });
      installClient(client);
      socket.emit("auth:success", { method: "token" });
    } catch {
      await storage.set(".auth", null);
      stopTalkPolling();
      lineClient = null;
      socket.emit("auth:none");
    }
  });

  // Login with email + password
  socket.on("auth:password", async ({ email, password }) => {
    if (!email || !password) {
      return socket.emit("auth:error", { error: "email and password required" });
    }
    try {
      const client = await loginWithPassword(
        {
          email,
          password,
          onPincodeRequest(pincode) {
            socket.emit("auth:pincode", { pincode });
          },
        },
        { device: "DESKTOPWIN", storage, fetch: undiciFetch },
      );
      installClient(client);
      // Explicitly persist the access token after login
      if (lineClient.authToken) await storage.set(".auth", lineClient.authToken);
      socket.emit("auth:success", { method: "password" });
    } catch (e) {
      lineClient = null;
      stopTalkPolling();
      socket.emit("auth:error", { error: e.message });
    }
  });

  // Login with QR code
  socket.on("auth:qr", async () => {
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
        { device: "DESKTOPWIN", storage, fetch: undiciFetch },
      );
      installClient(client);
      // Explicitly persist the access token after login
      if (lineClient.authToken) await storage.set(".auth", lineClient.authToken);
      socket.emit("auth:success", { method: "qr" });
    } catch (e) {
      lineClient = null;
      stopTalkPolling();
      socket.emit("auth:error", { error: e.message });
    }
  });
});

// --- Start ---

const PORT = process.env.PORT ?? 3000;
httpServer.listen(PORT, () => {
  console.log(`LINE Web Chat running at http://localhost:${PORT}`);
});
