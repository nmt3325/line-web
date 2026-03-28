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

// Cache raw (pre-decryption) IMAGE messages so we can download E2EE images later
const rawMessageCache = new Map();
const RAW_MSG_CACHE_MAX = 500;
const IMAGE_MIME_BY_EXT = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".heic": "image/heic",
  ".heif": "image/heif",
};

function cacheRawMessage(msg) {
  if (!msg?.id) return;
  const id = String(msg.id);
  if (rawMessageCache.size >= RAW_MSG_CACHE_MAX) {
    rawMessageCache.delete(rawMessageCache.keys().next().value);
  }
  rawMessageCache.set(id, msg);
}

function guessImageMimeType(fileName, fallback = "image/jpeg") {
  const ext = path.extname(String(fileName || "")).toLowerCase();
  return IMAGE_MIME_BY_EXT[ext] || fallback;
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

    const raw = await lineClient.base.talk.getPreviousMessagesV2WithRequest({
      request: {
        messageBoxId: box.id,
        endMessageId: {
          messageId: box.lastDeliveredMessageId.messageId,
          deliveredTime: box.lastDeliveredMessageId.deliveredTime,
        },
        messagesCount: limit,
      },
    });

    // E2EE メッセージを復号する（IMAGE メッセージは復号前にキャッシュ）
    const decrypted = await Promise.all(
      (raw ?? []).map(async (msg) => {
        if (msg.contentType === 1 || msg.contentType === "IMAGE") {
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
    const isE2EEImage = !!rawMsg?.chunks?.length;
    let file = null;

    // E2EE image: force safe key-selection for incoming 1:1 messages.
    if (isE2EEImage) {
      try {
        file = await downloadMediaByE2EESmart(rawMsg);
      } catch (e) {
        console.error("[image] E2EE smart download failed:", e.message);
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
              type: guessImageMimeType(
                e2eePayload.fileName,
                encryptedBlob.type || "image/jpeg",
              ),
            },
          );
        } catch (e) {
          console.error("[image] E2EE fallback decrypt failed:", e.message);
        }
      }
    } else {
      // Non-E2EE image
      file = await lineClient.base.obs.downloadMessageData({ messageId, isPreview });
    }

    if (!file) return res.status(404).json({ error: "Image not found" });

    const arrayBuffer = await file.arrayBuffer();
    res.set("Content-Type", file.type || "image/jpeg");
    res.set("Cache-Control", "public, max-age=3600");
    res.send(Buffer.from(arrayBuffer));
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
      const mimeType = (req.headers["content-type"] || "image/jpeg").split(";")[0].trim();
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
        cacheRawMessage(sentMessage);
      } else {
        // グループチャット: 非E2EE
        const { objId } = await lineClient.base.obs.uploadObjTalk(mid, "image", blob);
        sentMessage = await lineClient.base.talk.sendMessage({
          to: mid,
          contentType: 1,
          contentMetadata: { OID: objId },
        });
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
          // IMAGE メッセージは復号前にキャッシュ（E2EE画像ダウンロード用）
          if (msg.contentType === 1 || msg.contentType === "IMAGE") {
            cacheRawMessage(msg);
          }
          try {
            msg = await client.base.e2ee.decryptE2EEMessage(msg);
          } catch (e) {
            console.error("[E2EE] decrypt error (skipping message):", e.message);
          }
          io.emit("chat:message", formatMessage(msg));
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
