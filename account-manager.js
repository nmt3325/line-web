import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { writeFile, rm, copyFile } from "node:fs/promises";
import path from "path";
import { Agent, fetch as undiciFetch } from "undici";
import { SafeJsonFileStorage } from "./safe-storage.js";
import { MessageStore } from "./message-store.js";

const ACCOUNTS_DIR = "./accounts";
const REGISTRY_PATH = path.join(ACCOUNTS_DIR, "accounts.json");
const LEGACY_STORAGE_PATH = "./line-storage.json";
const LEGACY_DB_PATH = "./messages.db";

// 1アカウント分の状態。LINEクライアント・ストレージ・メッセージDB・各種キャッシュを保持する。
// 全アカウントが同時に存在しうるため、グローバルではなくセッション単位で状態を持つ。
export class Session {
  constructor(meta) {
    this.id = meta.id;
    // meta: { id, mid, name, avatarUrl, createdAt }
    this.meta = { mid: "", name: "", avatarUrl: null, createdAt: Date.now(), ...meta };
    const dir = path.join(ACCOUNTS_DIR, this.id);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.storage = new SafeJsonFileStorage(path.join(dir, "line-storage.json"));
    this.messageStore = new MessageStore(path.join(dir, "messages.db"));
    // アカウントごとに専用の HTTP/2 コネクションプールを持つ。
    // 全アカウント常時接続時、ログインのロングポーリング（最大150秒接続を保持）が
    // 他アカウントのポーリングとプールを共有して衝突し "fetch failed" になるのを防ぐ。
    // headersTimeout/bodyTimeout はロングポーリング(155秒)を上回る値にする。
    this.dispatcher = new Agent({
      allowH2: true,
      headersTimeout: 310000,
      bodyTimeout: 310000,
      connect: { timeout: 30000 },
    });
    this.fetch = (input, init) => undiciFetch(input, { ...(init || {}), dispatcher: this.dispatcher });
    /** @type {import("@evex/linejs").Client | null} */
    this.client = null;
    this.pollingAbortController = null;
    // ログイン処理の多重実行を防ぐフラグ（PIN待ちの間も true のまま）
    this.authInProgress = false;
    // 表示名の解決キャッシュ（システムメッセージ・プッシュ通知用）
    this.contactNameCache = new Map();
    // 復号前のメディアメッセージのキャッシュ（E2EEメディアダウンロード用）
    this.rawMessageCache = new Map();
    // getMessageBoxes の短時間共有キャッシュ
    this.messageBoxesCache = { promise: null, time: 0 };
  }

  get connected() {
    return !!this.client;
  }

  get dir() {
    return path.join(ACCOUNTS_DIR, this.id);
  }

  // フロントへ返す公開情報
  toPublic() {
    return {
      id: this.id,
      mid: this.meta.mid || "",
      name: this.meta.name || "",
      avatarUrl: this.meta.avatarUrl || null,
      connected: this.connected,
    };
  }
}

// 複数アカウントの登録簿（accounts.json）とセッションのライフサイクルを管理する。
export class AccountManager {
  constructor() {
    if (!existsSync(ACCOUNTS_DIR)) mkdirSync(ACCOUNTS_DIR, { recursive: true });
    /** @type {Map<string, Session>} */
    this.sessions = new Map();
    this._loadRegistry();
  }

  _loadRegistry() {
    let metas = [];
    try {
      if (existsSync(REGISTRY_PATH)) metas = JSON.parse(readFileSync(REGISTRY_PATH, "utf-8"));
    } catch (e) {
      console.warn("[accounts] failed to read registry:", e.message);
    }
    if (!Array.isArray(metas)) metas = [];
    for (const meta of metas) {
      if (meta && meta.id) this.sessions.set(meta.id, new Session(meta));
    }
  }

  async _saveRegistry() {
    const metas = [...this.sessions.values()].map((s) => s.meta);
    const tmp = REGISTRY_PATH + ".tmp";
    await writeFile(tmp, JSON.stringify(metas), "utf-8");
    const { rename } = await import("node:fs/promises");
    await rename(tmp, REGISTRY_PATH);
  }

  list() {
    return [...this.sessions.values()];
  }

  get(id) {
    return id ? this.sessions.get(id) : undefined;
  }

  findByMid(mid) {
    const target = String(mid || "");
    if (!target) return undefined;
    return [...this.sessions.values()].find((s) => String(s.meta.mid) === target);
  }

  // 新規（未ログイン）セッションを作成して登録する。
  createSession() {
    const id = randomUUID();
    const session = new Session({ id, createdAt: Date.now() });
    this.sessions.set(id, session);
    return session;
  }

  async updateMeta(session, patch) {
    session.meta = { ...session.meta, ...patch };
    await this._saveRegistry();
  }

  async remove(session) {
    if (!session) return;
    this.sessions.delete(session.id);
    await this._saveRegistry();
    try { session.messageStore.close(); } catch {}
    try { session.dispatcher.destroy(); } catch {}
    try { await rm(session.dir, { recursive: true, force: true }); } catch (e) {
      console.warn("[accounts] failed to remove session dir:", e.message);
    }
  }

  // 旧バージョンの単一アカウントデータ（./line-storage.json, ./messages.db）を
  // 1つ目のアカウントとして取り込む。登録簿が空のときだけ実行。
  async migrateLegacyIfNeeded() {
    if (this.sessions.size > 0) return null;
    if (!existsSync(LEGACY_STORAGE_PATH)) return null;
    console.log("[accounts] migrating legacy single-account data into a new account");

    // Session 生成前にファイルをコピーする。
    // SafeJsonFileStorage/MessageStore はコンストラクタでファイルを初期化するため、
    // 先にコピーしておかないと空ファイルで上書きされてしまう。
    const id = randomUUID();
    const dir = path.join(ACCOUNTS_DIR, id);
    mkdirSync(dir, { recursive: true });
    try {
      await copyFile(LEGACY_STORAGE_PATH, path.join(dir, "line-storage.json"));
    } catch (e) {
      console.warn("[accounts] legacy storage copy failed:", e.message);
    }
    if (existsSync(LEGACY_DB_PATH)) {
      try {
        await copyFile(LEGACY_DB_PATH, path.join(dir, "messages.db"));
      } catch (e) {
        console.warn("[accounts] legacy db copy failed:", e.message);
      }
    }

    const session = new Session({ id, createdAt: Date.now() });
    this.sessions.set(id, session);
    await this._saveRegistry();
    return session;
  }
}
