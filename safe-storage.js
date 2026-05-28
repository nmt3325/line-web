import { existsSync } from "node:fs";
import { copyFile, readFile, rename, writeFile } from "node:fs/promises";

const REPAIR_PAIR_REGEX = /"([^"\\]+)"\s*:\s*("(?:\\.|[^"\\])*"|true|false|null|-?\d+(?:\.\d+)?(?:[eE][+\-]?\d+)?)/g;

function ensureObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value;
}

function normalizeE2EEAliases(data) {
  let changed = false;
  const normalized = { ...data };

  for (const [key, value] of Object.entries(data)) {
    if (!key.startsWith("e2eeKeys:u")) continue;

    let parsed = value;
    if (typeof parsed === "string") {
      try {
        parsed = JSON.parse(parsed);
      } catch {
        continue;
      }
    }
    if (!parsed || typeof parsed !== "object") continue;

    const keyId = parsed.keyId == null ? null : String(parsed.keyId);
    if (!keyId) continue;

    const keyIdStorageKey = `e2eeKeys:${keyId}`;
    if (normalized[keyIdStorageKey] === undefined) {
      normalized[keyIdStorageKey] = typeof value === "string"
        ? value
        : JSON.stringify(parsed);
      changed = true;
    }
  }

  return { normalized, changed };
}

function repairFromRaw(raw) {
  const repaired = {};
  for (const match of raw.matchAll(REPAIR_PAIR_REGEX)) {
    const key = match[1];
    const valueText = match[2];
    try {
      repaired[key] = JSON.parse(valueText);
    } catch {
      // ignore invalid pair
    }
  }
  const { normalized } = normalizeE2EEAliases(repaired);
  return normalized;
}

export class SafeJsonFileStorage {
  constructor(path) {
    this.path = path;
    this._queue = Promise.resolve();
    this._ready = this._ensureFile();
  }

  async set(key, value) {
    await this._withLock(async () => {
      const data = await this._readAllUnlocked();
      data[key] = value;
      await this._writeAllUnlocked(data);
    });
  }

  async get(key) {
    return await this._withLock(async () => {
      const data = await this._readAllUnlocked();
      return data[key];
    });
  }

  async delete(key) {
    await this._withLock(async () => {
      const data = await this._readAllUnlocked();
      delete data[key];
      await this._writeAllUnlocked(data);
    });
  }

  async clear() {
    await this._withLock(async () => {
      await this._writeAllUnlocked({});
    });
  }

  async migrate(storage) {
    await this._withLock(async () => {
      const kv = await this._readAllUnlocked();
      for (const [key, value] of Object.entries(kv)) {
        await storage.set(key, value);
      }
    });
  }

  async _withLock(task) {
    const run = this._queue
      .then(() => this._ready)
      .then(task);

    this._queue = run.catch(() => {});
    return await run;
  }

  async _ensureFile() {
    if (!existsSync(this.path)) {
      await this._writeAllUnlocked({});
      return;
    }

    const raw = await readFile(this.path, "utf-8");
    if (!raw.trim()) {
      await this._writeAllUnlocked({});
    }
  }

  async _readAllUnlocked() {
    const raw = await readFile(this.path, "utf-8");
    const text = raw.trim();
    if (!text) return {};

    try {
      const parsed = ensureObject(JSON.parse(text));
      const { normalized, changed } = normalizeE2EEAliases(parsed);
      if (changed) {
        await this._writeAllUnlocked(normalized);
      }
      return normalized;
    } catch {
      const backupPath = `${this.path}.corrupt.${Date.now()}.bak`;
      await copyFile(this.path, backupPath);
      const repaired = repairFromRaw(text);
      if (Object.keys(repaired).length > 0) {
        await this._writeAllUnlocked(repaired);
        return repaired;
      }
      await this._writeAllUnlocked({});
      return {};
    }
  }

  async _writeAllUnlocked(data) {
    const tempPath = `${this.path}.tmp`;
    await writeFile(tempPath, JSON.stringify(data), "utf-8");
    await rename(tempPath, this.path);
  }
}
