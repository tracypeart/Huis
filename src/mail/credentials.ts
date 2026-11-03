import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/**
 * Mailbox refresh tokens, encrypted at rest with AES-256-GCM.
 *
 * The key is derived per firm from the master key, under a label separate
 * from evidence encryption, and the ciphertext is bound to the mailbox
 * (firm, provider and account), so a token can't be moved to another mailbox
 * or firm. In production the master key lives in the cloud key service.
 */
const VERSION = 1;

function key(masterKeyBase64: string, firmId: string): Buffer {
  const master = Buffer.from(masterKeyBase64, "base64");
  if (master.length !== 32) throw new Error("HUIS_STORAGE_MASTER_KEY must be 32 random bytes, base64-encoded.");
  return Buffer.from(hkdfSync("sha256", master, Buffer.from(firmId), "huis-mail-credentials-v1", 32));
}

const aad = (firmId: string, provider: string, subject: string) => Buffer.from(`${firmId}\n${provider}\n${subject}`);

export function sealCredential(masterKeyBase64: string, mailbox: { firmId: string; provider: string; subject: string }, refreshToken: string): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(masterKeyBase64, mailbox.firmId), iv);
  c.setAAD(aad(mailbox.firmId, mailbox.provider, mailbox.subject));
  const body = Buffer.concat([c.update(refreshToken, "utf8"), c.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, c.getAuthTag(), body]);
}

export function openCredential(masterKeyBase64: string, mailbox: { firmId: string; provider: string; subject: string }, sealed: Buffer): string {
  if (sealed.length < 30 || sealed[0] !== VERSION) throw new Error("unreadable credential");
  const d = createDecipheriv("aes-256-gcm", key(masterKeyBase64, mailbox.firmId), sealed.subarray(1, 13));
  d.setAAD(aad(mailbox.firmId, mailbox.provider, mailbox.subject));
  d.setAuthTag(sealed.subarray(13, 29));
  return Buffer.concat([d.update(sealed.subarray(29)), d.final()]).toString("utf8");
}
