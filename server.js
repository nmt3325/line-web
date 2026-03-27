import { Agent, fetch as undiciFetch, Request as UndiciRequest, setGlobalDispatcher } from "undici";
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { loginWithPassword, loginWithQR, loginWithAuthToken } from "@evex/linejs";
import { FileStorage } from "@evex/linejs/storage";
import QRCode from "qrcode";
import path from "path";
import { fileURLToPath } from "url";
import { writeFile } from "fs/promises";

// LINE のプッシュ通知（メッセージ受信ポーリング）は HTTP/2 が必要
setGlobalDispatcher(new Agent({ allowH2: true }));
globalThis.Request = UndiciRequest;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

let storage = new FileStorage("./line-storage.json");
const LINE_PROFILE_CDN = "https://profile.line-scdn.net";

// Cache raw (pre-decryption) IMAGE messages so we can download E2EE images later
const rawMessageCache = new Map();
const RAW_MSG_CACHE_MAX = 500;

function cacheRawMessage(msg) {
  if (!msg?.id) return;
  const id = String(msg.id);
  if (rawMessageCache.size >= RAW_MSG_CACHE_MAX) {
    rawMessageCache.delete(rawMessageCache.keys().next().value);
  }
  rawMessageCache.set(id, msg);
}

/** @type {import("@evex/linejs").Client | null} */
let lineClient = null;

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
  return {
    id: msg.id?.toString() ?? "",
    from: msg._from?.toString() ?? msg.from?.toString() ?? "",
    to: msg.to?.toString() ?? "",
    text: msg.text ?? "",
    contentType: msg.contentType ?? "NONE",
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
      // Abort active push (HTTP/2) connections and stop the polling loop
      for (const conn of lineClient.base.push.conns ?? []) {
        try { conn.reqStream?.abort?.abort(); } catch {}
      }
      lineClient.base.authToken = undefined;
      lineClient = null;
    }
    // Reset the global HTTP/2 agent so the next login gets fresh connections
    setGlobalDispatcher(new Agent({ allowH2: true }));
    await writeFile("./line-storage.json", "{}");
    storage = new FileStorage("./line-storage.json");
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
    lineClient = await loginWithAuthToken(token, {
      device: "DESKTOPWIN",
      storage,
      fetch: undiciFetch,
    });
    setupClientListeners();
    res.json({ success: true });
  } catch (e) {
    lineClient = null;
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
    let file = null;

    // E2EE image: raw message has chunks
    if (rawMsg?.chunks?.length) {
      try {
        file = await lineClient.base.obs.downloadMediaByE2EE(rawMsg);
      } catch (e) {
        console.error("[image] E2EE download failed:", e.message);
      }
    }

    // Non-E2EE fallback
    if (!file) {
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
      e2ee: true,
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
async function listenWithRestart() {
  while (lineClient) {
    try {
      const polling = lineClient.base.createPolling();
      for await (const event of polling.listenTalkEvents()) {
        if (event.type === "SEND_MESSAGE" || event.type === "RECEIVE_MESSAGE") {
          let msg = event.message;
          // IMAGE メッセージは復号前にキャッシュ（E2EE画像ダウンロード用）
          if (msg.contentType === 1 || msg.contentType === "IMAGE") {
            cacheRawMessage(msg);
          }
          try {
            msg = await lineClient.base.e2ee.decryptE2EEMessage(msg);
          } catch (e) {
            console.error("[E2EE] decrypt error (skipping message):", e.message);
          }
          io.emit("chat:message", {
            id: msg.id?.toString() ?? "",
            from: msg._from?.toString() ?? msg.from?.toString() ?? "",
            to: msg.to?.toString() ?? "",
            text: msg.text ?? "",
            contentType: msg.contentType ?? "NONE",
            createdTime: msg.createdTime ? Number(msg.createdTime) : Date.now(),
          });
        }
      }
      console.log("[polling] talk stream ended — restarting");
    } catch (e) {
      console.error("[polling] error:", e.message, "— restarting in 2s");
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

function setupClientListeners() {
  // update:authtoken is emitted on base, not on the Client wrapper
  lineClient.base.on("update:authtoken", async (token) => {
    await storage.set(".auth", token);
  });

  listenWithRestart();
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
      lineClient = await loginWithAuthToken(token, { device: "DESKTOPWIN", storage, fetch: undiciFetch });
      setupClientListeners();
      socket.emit("auth:success", { method: "token" });
    } catch {
      await storage.set(".auth", null);
      socket.emit("auth:none");
    }
  });

  // Login with email + password
  socket.on("auth:password", async ({ email, password }) => {
    if (!email || !password) {
      return socket.emit("auth:error", { error: "email and password required" });
    }
    try {
      lineClient = await loginWithPassword(
        {
          email,
          password,
          onPincodeRequest(pincode) {
            socket.emit("auth:pincode", { pincode });
          },
        },
        { device: "DESKTOPWIN", storage, fetch: undiciFetch },
      );
      // Explicitly persist the access token after login
      if (lineClient.authToken) await storage.set(".auth", lineClient.authToken);
      setupClientListeners();
      socket.emit("auth:success", { method: "password" });
    } catch (e) {
      lineClient = null;
      socket.emit("auth:error", { error: e.message });
    }
  });

  // Login with QR code
  socket.on("auth:qr", async () => {
    try {
      lineClient = await loginWithQR(
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
      // Explicitly persist the access token after login
      if (lineClient.authToken) await storage.set(".auth", lineClient.authToken);
      setupClientListeners();
      socket.emit("auth:success", { method: "qr" });
    } catch (e) {
      lineClient = null;
      socket.emit("auth:error", { error: e.message });
    }
  });
});

// --- Start ---

const PORT = process.env.PORT ?? 3000;
httpServer.listen(PORT, () => {
  console.log(`LINE Web Chat running at http://localhost:${PORT}`);
});
