import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PassThrough, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DecryptStream, EncryptStream, MasterKeyProvider, type KeyProvider } from "./encryption";

/** Raw object storage (bytes are already encrypted when they get here). */
export interface ObjectStore {
  put(key: string, body: Readable): Promise<void>;
  get(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

const KEY_PATTERN = /^[a-z0-9][a-z0-9/_.-]*$/;
function checkKey(key: string): void {
  if (!KEY_PATTERN.test(key) || key.includes("..") || key.includes("//") || key.endsWith("/")) {
    throw new Error("Invalid storage key");
  }
}

/** Local disk store for development. Production uses S3-compatible storage. */
export class LocalObjectStore implements ObjectStore {
  constructor(private readonly root: string) {}

  private file(key: string): string {
    checkKey(key);
    const full = path.resolve(this.root, key);
    if (!full.startsWith(path.resolve(this.root) + path.sep)) throw new Error("Invalid storage key");
    return full;
  }

  async put(key: string, body: Readable): Promise<void> {
    const target = this.file(key);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const tmp = `${target}.${randomUUID()}.partial`;
    try {
      await pipeline(body, createWriteStream(tmp, { flags: "wx", mode: 0o600 }));
      await rename(tmp, target);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  async get(key: string): Promise<Readable> {
    const f = this.file(key);
    await stat(f);
    return createReadStream(f);
  }

  async delete(key: string): Promise<void> {
    await rm(this.file(key), { force: true });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.file(key));
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Encrypting layer every evidence byte passes through. Callers only ever see
 * plaintext streams; storage only ever sees ciphertext.
 */
export class EvidenceVault {
  constructor(private readonly store: ObjectStore, private readonly keys: KeyProvider) {}

  /** Encrypts and stores a stream; returns the plaintext size and SHA-256. */
  async put(firmId: string, key: string, plaintext: Readable): Promise<{ size: number; sha256: string }> {
    const enc = new EncryptStream(await this.keys.firmKey(firmId), key);
    const out = new PassThrough();
    const writing = this.store.put(key, out);
    await Promise.all([pipeline(plaintext, enc, out), writing]);
    return enc.result();
  }

  /** Returns a verified plaintext stream. Errors if the object was altered. */
  async get(firmId: string, key: string): Promise<Readable> {
    const dec = new DecryptStream(await this.keys.firmKey(firmId), key);
    const raw = await this.store.get(key);
    raw.on("error", (e) => dec.destroy(e));
    return raw.pipe(dec);
  }

  delete(key: string): Promise<void> {
    return this.store.delete(key);
  }

  exists(key: string): Promise<boolean> {
    return this.store.exists(key);
  }
}

let vault: EvidenceVault | null = null;

/** Vault configured from the environment. */
export function evidenceVault(): EvidenceVault {
  if (vault) return vault;
  const master = process.env.HUIS_STORAGE_MASTER_KEY;
  if (!master) throw new Error("HUIS_STORAGE_MASTER_KEY is not set. Generate one with: openssl rand -base64 32");
  const dir = process.env.HUIS_STORAGE_DIR;
  if (!dir) throw new Error("HUIS_STORAGE_DIR is not set (production will use S3-compatible storage).");
  vault = new EvidenceVault(new LocalObjectStore(dir), new MasterKeyProvider(master));
  return vault;
}

export const storageKeys = {
  original: (firmId: string, matterId: string, evidenceId: string) =>
    `firm/${firmId}/matter/${matterId}/evidence/${evidenceId}/original`,
  stagingChunk: (firmId: string, sessionId: string, index: number) =>
    `firm/${firmId}/staging/${sessionId}/${String(index).padStart(6, "0")}`,
};
