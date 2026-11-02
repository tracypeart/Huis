import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { Transform, type TransformCallback } from "node:stream";

/**
 * Evidence encryption at rest.
 *
 * Every stored object gets its own random 256-bit data key. The data key is
 * wrapped (encrypted) with the firm's key-encryption key, so one firm's key
 * can never open another firm's files. In production the firm key comes from
 * a cloud key-management service; locally it is derived from HUIS_STORAGE_MASTER_KEY.
 *
 * Content is encrypted in 1 MiB segments with AES-256-GCM. Each segment is
 * authenticated on its own (so huge files stream without loading into memory)
 * and bound to its position, the object's storage key, and whether it is the
 * last segment — so segments cannot be reordered, swapped between files or
 * truncated without detection.
 *
 * Object layout:
 *   "HUIS" | version(1) | wrapped key: iv(12) ct(32) tag(16) | nonce base(8)
 *   segments: plaintextLength uint32 BE (top bit = final) | ciphertext | tag(16)
 */
const MAGIC = Buffer.from("HUIS");
const VERSION = 1;
export const SEGMENT_SIZE = 1024 * 1024;
const FINAL_FLAG = 0x80000000;
const HEADER_LEN = MAGIC.length + 1 + 12 + 32 + 16 + 8;

export interface KeyProvider {
  /** The firm's key-encryption key (32 bytes). */
  firmKey(firmId: string): Promise<Buffer>;
}

/** Derives per-firm keys from one master key. For local/dev; production uses KMS. */
export class MasterKeyProvider implements KeyProvider {
  private readonly master: Buffer;
  constructor(masterKeyBase64: string) {
    this.master = Buffer.from(masterKeyBase64, "base64");
    if (this.master.length !== 32) throw new Error("HUIS_STORAGE_MASTER_KEY must be 32 random bytes, base64-encoded.");
  }
  async firmKey(firmId: string): Promise<Buffer> {
    return Buffer.from(hkdfSync("sha256", this.master, Buffer.from(firmId), "huis-evidence-kek-v1", 32));
  }
}

function segmentAad(storageKey: string, index: number, final: boolean): Buffer {
  const meta = Buffer.alloc(5);
  meta.writeUInt32BE(index, 0);
  meta.writeUInt8(final ? 1 : 0, 4);
  return Buffer.concat([createHash("sha256").update(storageKey).digest(), meta]);
}

function segmentNonce(base: Buffer, index: number): Buffer {
  const n = Buffer.alloc(12);
  base.copy(n, 0);
  n.writeUInt32BE(index, 8);
  return n;
}

/** Encrypts a plaintext stream. Also reports the plaintext size and SHA-256. */
export class EncryptStream extends Transform {
  private readonly dataKey = randomBytes(32);
  private readonly nonceBase = randomBytes(8);
  private pending: Buffer[] = [];
  private pendingLen = 0;
  private index = 0;
  private readonly hash = createHash("sha256");
  private size = 0;
  private headerSent = false;

  constructor(private readonly firmKey: Buffer, private readonly storageKey: string) {
    super();
  }

  /** Available after the stream finishes. */
  result(): { size: number; sha256: string } {
    return { size: this.size, sha256: this.hashHex ?? "" };
  }
  private hashHex: string | null = null;

  private header(): Buffer {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.firmKey, iv);
    c.setAAD(Buffer.from(`huis-wrap|${this.storageKey}`));
    const wrapped = Buffer.concat([c.update(this.dataKey), c.final()]);
    return Buffer.concat([MAGIC, Buffer.from([VERSION]), iv, wrapped, c.getAuthTag(), this.nonceBase]);
  }

  private emitSegment(plain: Buffer, final: boolean): void {
    if (!this.headerSent) {
      this.push(this.header());
      this.headerSent = true;
    }
    const c = createCipheriv("aes-256-gcm", this.dataKey, segmentNonce(this.nonceBase, this.index));
    c.setAAD(segmentAad(this.storageKey, this.index, final));
    const ct = Buffer.concat([c.update(plain), c.final()]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE((plain.length | (final ? FINAL_FLAG : 0)) >>> 0, 0);
    this.push(Buffer.concat([len, ct, c.getAuthTag()]));
    this.index += 1;
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.hash.update(chunk);
    this.size += chunk.length;
    this.pending.push(chunk);
    this.pendingLen += chunk.length;
    // Keep at least one byte back so the true final segment is always flagged.
    while (this.pendingLen > SEGMENT_SIZE) {
      const all = Buffer.concat(this.pending);
      this.emitSegment(all.subarray(0, SEGMENT_SIZE), false);
      const rest = all.subarray(SEGMENT_SIZE);
      this.pending = [rest];
      this.pendingLen = rest.length;
    }
    cb();
  }

  override _flush(cb: TransformCallback): void {
    this.emitSegment(Buffer.concat(this.pending), true);
    this.hashHex = this.hash.digest("hex");
    cb();
  }
}

/** Decrypts and verifies a stored object, segment by segment. */
export class DecryptStream extends Transform {
  private buf: Buffer = Buffer.alloc(0);
  private dataKey: Buffer | null = null;
  private nonceBase: Buffer | null = null;
  private index = 0;
  private finished = false;

  constructor(private readonly firmKey: Buffer, private readonly storageKey: string) {
    super();
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    try {
      this.drain();
      cb();
    } catch (err) {
      cb(err as Error);
    }
  }

  private drain(): void {
    if (!this.dataKey) {
      if (this.buf.length < HEADER_LEN) return;
      if (!this.buf.subarray(0, 4).equals(MAGIC) || this.buf[4] !== VERSION) throw new Error("Not a Huis encrypted object");
      const iv = this.buf.subarray(5, 17);
      const wrapped = this.buf.subarray(17, 49);
      const tag = this.buf.subarray(49, 65);
      this.nonceBase = Buffer.from(this.buf.subarray(65, 73));
      const d = createDecipheriv("aes-256-gcm", this.firmKey, iv);
      d.setAAD(Buffer.from(`huis-wrap|${this.storageKey}`));
      d.setAuthTag(tag);
      this.dataKey = Buffer.concat([d.update(wrapped), d.final()]);
      this.buf = this.buf.subarray(HEADER_LEN);
    }
    while (this.buf.length >= 4) {
      if (this.finished) throw new Error("Unexpected data after final segment");
      const raw = this.buf.readUInt32BE(0);
      const final = (raw & FINAL_FLAG) !== 0;
      const len = raw & ~FINAL_FLAG;
      if (len > SEGMENT_SIZE) throw new Error("Corrupt segment length");
      const total = 4 + len + 16;
      if (this.buf.length < total) return;
      const d = createDecipheriv("aes-256-gcm", this.dataKey, segmentNonce(this.nonceBase!, this.index));
      d.setAAD(segmentAad(this.storageKey, this.index, final));
      d.setAuthTag(this.buf.subarray(4 + len, total));
      const plain = Buffer.concat([d.update(this.buf.subarray(4, 4 + len)), d.final()]);
      this.push(plain);
      this.index += 1;
      this.finished = final;
      this.buf = this.buf.subarray(total);
    }
  }

  override _flush(cb: TransformCallback): void {
    if (!this.finished || this.buf.length > 0) {
      cb(new Error("Encrypted object is truncated or damaged"));
      return;
    }
    cb();
  }
}
