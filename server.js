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

const storage = new FileStorage("./line-storage.json");
const LINE_PROFILE_CDN = "https://profile.line-scdn.net";

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
    lineClient = null;
    await writeFile("./line-storage.json", "{}");
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

    const chunkSize = 50;
    const groups = [];
    for (let i = 0; i < groupMids.length; i += chunkSize) {
      const chunk = groupMids.slice(i, i + chunkSize);
      const raw = await lineClient.base.talk.getChats({ chatMids: chunk });
      for (const chat of raw?.chats ?? []) {
        const picturePath = chat.picturePath ?? "";
        groups.push({
          mid: String(chat.chatMid ?? ""),
          name: chat.chatName ?? chat.chatMid ?? "",
          avatarUrl: picturePath ? LINE_PROFILE_CDN + picturePath : null,
          memberCount: chat.memberCount ?? 0,
        });
      }
    }
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

    // Use talk.getContacts which works for this account type
    const chunkSize = 50;
    const contacts = [];
    for (let i = 0; i < mids.length; i += chunkSize) {
      const chunk = mids.slice(i, i + chunkSize);
      const raw = await lineClient.base.talk.getContacts({ mids: chunk });
      for (const c of raw ?? []) {
        contacts.push(formatContact(c));
      }
    }
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

    // E2EE メッセージを復号する
    const decrypted = await Promise.all(
      (raw ?? []).map(async (msg) => {
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

    const messages = decrypted.map(formatMessage);
    res.json({ messages });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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
