import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, copyFile, mkdir } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HuisDb, RequestContext } from "../src/db/tenant";
import { NotFoundError, PermissionDeniedError } from "../src/errors";
import {
  assembleOriginal, authorizeDownload, CHUNK_SIZE, cleanupStaging, custodyLog, getEvidence, getUploadSession,
  listEvidence, markChunkReceived, moveEvidence, newEvidenceId, recordEvidence, startUpload, storeChunk,
  type StartUploadInput,
} from "../src/services/evidence";
import { createClient } from "../src/services/clients";
import { addMatterMember, createMatter, listMatterFolders } from "../src/services/matters";
import { inviteUser } from "../src/services/users";
import { MasterKeyProvider } from "../src/storage/encryption";
import { ClamdScanner, parseClamdReply, type MalwareScanner } from "../src/storage/scanner";
import { EvidenceVault, LocalObjectStore } from "../src/storage/store";
import { EvidenceProcessor } from "../src/worker/processor";
import { createTestDatabase, newFirm, type TestDatabase } from "./helpers";

const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

let t: TestDatabase;
let db: HuisDb;
let dir: string;
let vault: EvidenceVault;
let clamd: net.Server;
let clamdPort = 0;
let scanner: MalwareScanner;
let processor: EvidenceProcessor;

/** A minimal clamd speaking the real INSTREAM protocol; flags the EICAR test string. */
function startFakeClamd(): Promise<net.Server> {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      let buf: Buffer = Buffer.alloc(0);
      let content: Buffer = Buffer.alloc(0);
      let headerSeen = false;
      sock.on("data", (d: Buffer) => {
        buf = Buffer.concat([buf, d]);
        if (!headerSeen) {
          const end = buf.indexOf(0);
          if (end < 0) return;
          if (buf.subarray(0, end).toString() !== "zINSTREAM") { sock.end("UNKNOWN COMMAND\0"); return; }
          headerSeen = true;
          buf = buf.subarray(end + 1);
        }
        while (buf.length >= 4) {
          const len = buf.readUInt32BE(0);
          if (len === 0) {
            sock.end(content.includes(Buffer.from(EICAR)) ? "stream: Eicar-Test-Signature FOUND\0" : "stream: OK\0");
            return;
          }
          if (buf.length < 4 + len) return;
          content = Buffer.concat([content, buf.subarray(4, 4 + len)]);
          buf = buf.subarray(4 + len);
        }
      });
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

beforeAll(async () => {
  t = await createTestDatabase();
  db = t.db;
  dir = await mkdtemp(path.join(os.tmpdir(), "huis-vault-"));
  vault = new EvidenceVault(new LocalObjectStore(dir), new MasterKeyProvider(randomBytes(32).toString("base64")));
  clamd = await startFakeClamd();
  clamdPort = (clamd.address() as net.AddressInfo).port;
  scanner = new ClamdScanner("127.0.0.1", clamdPort);
  processor = new EvidenceProcessor(t.worker, vault, scanner);
});

afterAll(async () => {
  clamd?.close();
  await t?.drop();
  if (dir) await rm(dir, { recursive: true, force: true });
});

/** Full upload exactly as the web app does it: start, chunks (any order), assemble, record. */
async function upload(ctx: RequestContext, input: Omit<StartUploadInput, "totalSize">, content: Buffer, order: "forward" | "reverse" = "forward") {
  const session = await db.withFirm(ctx, (s) => startUpload(s, { ...input, totalSize: content.length }));
  const indexes = Array.from({ length: session.chunkCount }, (_, i) => i);
  if (order === "reverse") indexes.reverse();
  for (const i of indexes) {
    const part = content.subarray(i * session.chunkSize, (i + 1) * session.chunkSize);
    await storeChunk(vault, session, i, part);
    await db.withFirm(ctx, (s) => markChunkReceived(s, session.id, i));
  }
  const fresh = await db.withFirm(ctx, (s) => getUploadSession(s, session.id));
  const id = newEvidenceId();
  const file = await assembleOriginal(vault, fresh, id);
  const item = await db.withFirm(ctx, (s) => recordEvidence(s, fresh, id, file));
  await cleanupStaging(vault, fresh);
  return item;
}

async function setup(opts: { restricted?: boolean } = {}) {
  const f = await newFirm(db);
  const extra = await db.withFirm(f.owner, async (s) => {
    const client = await createClient(s, { kind: "person", displayName: "Client" });
    const para = await inviteUser(s, { email: `p@${f.slug}.example`, fullName: "Pat Para", role: "paralegal", locationId: f.locationId });
    const portal = await inviteUser(s, { email: `c@${f.slug}.example`, fullName: "Casey Client", role: "client", locationId: f.locationId });
    const matter = await createMatter(s, {
      title: "Evidence matter", clientId: client.id, leadAttorneyId: f.ownerUserId, jurisdictionState: "UT", restricted: opts.restricted,
    });
    return { client, para, portal, matter };
  });
  return {
    ...f, ...extra,
    paraCtx: { firmId: f.firmId, userId: extra.para.id } as RequestContext,
    portalCtx: { firmId: f.firmId, userId: extra.portal.id } as RequestContext,
  };
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

describe("encryption at rest", () => {
  it("round-trips multi-segment files and never stores plaintext", async () => {
    const content = Buffer.concat([Buffer.from("CONFIDENTIAL-MARKER "), randomBytes(3.5 * 1024 * 1024)]);
    const r = await vault.put("f1", "firm/f1/test/a", Readable.from([content]));
    expect(r).toEqual({ size: content.length, sha256: sha(content) });
    const raw = await readFile(path.join(dir, "firm/f1/test/a"));
    expect(raw.includes(Buffer.from("CONFIDENTIAL-MARKER"))).toBe(false);
    const back = Buffer.concat(await (await vault.get("f1", "firm/f1/test/a")).toArray());
    expect(back.equals(content)).toBe(true);
  });

  it("detects tampering, truncation, swapped files and the wrong firm's key", async () => {
    const content = randomBytes(2.5 * 1024 * 1024);
    await vault.put("f1", "firm/f1/test/b", Readable.from([content]));
    const file = path.join(dir, "firm/f1/test/b");
    const original = await readFile(file);
    const read = async (firm: string, key: string) => Buffer.concat(await (await vault.get(firm, key)).toArray());

    const flipped = Buffer.from(original); flipped[2_000_000]! ^= 1;
    await writeFile(file, flipped);
    await expect(read("f1", "firm/f1/test/b")).rejects.toThrow();

    await writeFile(file, original.subarray(0, original.length - 500_000));
    await expect(read("f1", "firm/f1/test/b")).rejects.toThrow();

    await writeFile(file, original);
    await mkdir(path.join(dir, "firm/f1/test2"), { recursive: true });
    await copyFile(file, path.join(dir, "firm/f1/test2/c"));
    await expect(read("f1", "firm/f1/test2/c")).rejects.toThrow();
    await expect(read("f2", "firm/f1/test/b")).rejects.toThrow();
    expect((await read("f1", "firm/f1/test/b")).equals(content)).toBe(true);
  });

  it("rejects unsafe storage keys", async () => {
    await expect(vault.put("f1", "../escape", Readable.from([Buffer.from("x")]))).rejects.toThrow(/Invalid storage key/);
  });
});

describe("upload, fingerprint, scan and download", () => {
  it("chunks arrive in any order; the fingerprint matches; files are held until scanned clean", async () => {
    const x = await setup();
    const content = randomBytes(CHUNK_SIZE * 2 + 12345);
    const item = await upload(x.owner, { matterId: x.matter.id, filename: "deposition.pdf", receivedFrom: "Opposing counsel", dateReceived: "2026-10-15" }, content, "reverse");
    expect(item).toMatchObject({ status: "pending_scan", sha256: sha(content), sizeBytes: content.length, folderName: "Evidence", receivedFrom: "Opposing counsel", dateReceived: "2026-10-15" });

    await expect(db.withFirm(x.owner, (s) => authorizeDownload(s, item.id))).rejects.toBeInstanceOf(PermissionDeniedError);

    expect(await processor.drain()).toBe(1);
    const done = await db.withFirm(x.owner, (s) => getEvidence(s, item.id));
    expect(done.status).toBe("clean");
    expect(done.scanDetail).toMatch(/ClamAV/);

    await db.withFirm(x.owner, (s) => authorizeDownload(s, item.id));
    const log = await db.withFirm(x.owner, (s) => custodyLog(s, item.id));
    expect(log.events.map((e) => e.event)).toEqual(["received", "integrity_verified", "scanned_clean", "downloaded"]);
    expect(log.events[0]!.details).toMatchObject({ sha256: sha(content), received_from: "Opposing counsel" });
    expect(log.brokenAt).toBeNull();
  });

  it("quarantines malware and never allows it to be opened", async () => {
    const x = await setup();
    const item = await upload(x.owner, { matterId: x.matter.id, filename: "invoice.pdf" }, Buffer.from(`hello ${EICAR} world`));
    await processor.drain();
    const after = await db.withFirm(x.owner, (s) => getEvidence(s, item.id));
    expect(after.status).toBe("infected");
    expect(after.scanDetail).toMatch(/Threat detected/);
    await expect(db.withFirm(x.owner, (s) => authorizeDownload(s, item.id))).rejects.toThrow(/failed its security scan/);
  });

  it("flags a program disguised as a document", async () => {
    const x = await setup();
    const fake = Buffer.concat([Buffer.from([0x4d, 0x5a, 0x90, 0x00]), randomBytes(1000)]);
    const item = await upload(x.owner, { matterId: x.matter.id, filename: "contract.pdf" }, fake);
    await processor.drain();
    const after = await db.withFirm(x.owner, (s) => getEvidence(s, item.id));
    expect(after.detectedContentType).toBe("Windows executable");
    expect(after.scanDetail).toMatch(/is a program/);
  });

  it("links exact duplicates within a matter", async () => {
    const x = await setup();
    const content = randomBytes(5000);
    const first = await upload(x.owner, { matterId: x.matter.id, filename: "Employment Agreement.pdf" }, content);
    const second = await upload(x.owner, { matterId: x.matter.id, filename: "Employment Agreement FINAL.pdf" }, content);
    await processor.drain();
    const b = await db.withFirm(x.owner, (s) => getEvidence(s, second.id));
    expect(b.duplicateOf).toBe(first.id);
    const a = await db.withFirm(x.owner, (s) => getEvidence(s, first.id));
    expect(a.duplicateOf).toBeNull();
  });

  it("keeps files held if the scanner is down, and retries", async () => {
    const x = await setup();
    const item = await upload(x.owner, { matterId: x.matter.id, filename: "a.txt" }, Buffer.from("text"));
    const down = new EvidenceProcessor(t.worker, vault, new ClamdScanner("127.0.0.1", 1));
    await down.runOnce();
    expect((await db.withFirm(x.owner, (s) => getEvidence(s, item.id))).status).toBe("pending_scan");
    await t.admin.query("UPDATE huis.jobs SET run_after = now() WHERE evidence_id = $1", [item.id]);
    await processor.drain();
    expect((await db.withFirm(x.owner, (s) => getEvidence(s, item.id))).status).toBe("clean");
  });

  it("detects a stored file that was altered after upload", async () => {
    const x = await setup();
    const item = await upload(x.owner, { matterId: x.matter.id, filename: "b.bin" }, randomBytes(4000));
    const key = (await t.admin.query("SELECT storage_key FROM huis.evidence_items WHERE id = $1", [item.id])).rows[0].storage_key;
    const file = path.join(dir, key);
    const bytes = await readFile(file); bytes[bytes.length - 20]! ^= 1; await writeFile(file, bytes);
    await t.admin.query("UPDATE huis.jobs SET attempts = 5 WHERE evidence_id = $1", [item.id]);
    await processor.runOnce();
    const after = await db.withFirm(x.owner, (s) => getEvidence(s, item.id));
    expect(after.status).toBe("scan_failed");
  });

  it("rejects wrong chunk sizes and incomplete uploads", async () => {
    const x = await setup();
    const session = await db.withFirm(x.owner, (s) => startUpload(s, { matterId: x.matter.id, filename: "big.bin", totalSize: CHUNK_SIZE + 10 }));
    await expect(storeChunk(vault, session, 0, Buffer.alloc(100))).rejects.toThrow(/size/);
    await expect(storeChunk(vault, session, 5, Buffer.alloc(10))).rejects.toThrow(/chunk number/);
    await storeChunk(vault, session, 0, randomBytes(CHUNK_SIZE));
    await db.withFirm(x.owner, (s) => markChunkReceived(s, session.id, 0));
    const fresh = await db.withFirm(x.owner, (s) => getUploadSession(s, session.id));
    await expect(assembleOriginal(vault, fresh, newEvidenceId())).rejects.toThrow(/missing/);
  });

  it("supports empty files and folder paths from a thumb drive", async () => {
    const x = await setup();
    const item = await upload(x.owner, { matterId: x.matter.id, filename: "notes.txt", relativePath: "USB/2024/Notes/notes.txt", source: "external_drive" }, Buffer.alloc(0));
    expect(item).toMatchObject({ sizeBytes: 0, relativePath: "USB/2024/Notes/notes.txt", source: "external_drive" });
  });
});

describe("originals are immutable; custody is append-only", () => {
  it("blocks edits to the original record, scan results and custody events", async () => {
    const x = await setup();
    const item = await upload(x.owner, { matterId: x.matter.id, filename: "x.txt" }, Buffer.from("original"));
    await expect(db.withFirm(x.owner, (s) => s.client.query("UPDATE huis.evidence_items SET sha256 = repeat('0', 64) WHERE id = $1", [item.id])))
      .rejects.toThrow(/immutable/);
    await expect(db.withFirm(x.owner, (s) => s.client.query("UPDATE huis.evidence_items SET status = 'clean' WHERE id = $1", [item.id])))
      .rejects.toThrow(/scanner/);
    await expect(t.admin.query("DELETE FROM huis.evidence_items WHERE id = $1", [item.id])).rejects.toThrow(/append-only/);
    await expect(t.admin.query("UPDATE huis.evidence_custody_events SET event = 'x' WHERE evidence_id = $1", [item.id])).rejects.toThrow(/append-only/);
    await expect(db.withFirm(x.owner, (s) => s.client.query(
      "INSERT INTO huis.evidence_custody_events (firm_id, evidence_id, actor_user_id, event) VALUES ($1, $2, $3, 'scanned_clean')",
      [x.firmId, item.id, x.ownerUserId]))).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("moving to the red privileged area is allowed and recorded", async () => {
    const x = await setup();
    const item = await upload(x.owner, { matterId: x.matter.id, filename: "memo.docx" }, Buffer.from("memo"));
    const red = (await db.withFirm(x.owner, (s) => listMatterFolders(s, x.matter.id))).find((f) => f.isPrivilegedArea)!;
    await db.withFirm(x.owner, (s) => moveEvidence(s, item.id, red.id));
    const log = await db.withFirm(x.owner, (s) => custodyLog(s, item.id));
    expect(log.events.at(-1)).toMatchObject({ event: "moved", details: { from: "Evidence", to: "Privileged & Confidential" } });
  });

  it("the worker role cannot read evidence tables directly", async () => {
    await expect(t.worker.query("SELECT * FROM huis.evidence_items")).rejects.toThrow(/permission denied/);
    await expect(t.worker.query("SELECT * FROM huis.matters")).rejects.toThrow(/permission denied/);
  });
});

describe("privilege and isolation for evidence", () => {
  it("another firm cannot see or open evidence", async () => {
    const x = await setup();
    const other = await setup();
    const item = await upload(x.owner, { matterId: x.matter.id, filename: "secret.pdf" }, Buffer.from("secret"));
    await expect(db.withFirm(other.owner, (s) => getEvidence(s, item.id))).rejects.toBeInstanceOf(NotFoundError);
    await expect(db.withFirm(other.owner, (s) => authorizeDownload(s, item.id))).rejects.toBeInstanceOf(NotFoundError);
    await db.withFirm(other.owner, async (s) => {
      expect((await s.client.query("SELECT count(*)::int AS n FROM huis.evidence_custody_events WHERE evidence_id = $1", [item.id])).rows[0].n).toBe(0);
    });
  });

  it("ethical walls apply to evidence", async () => {
    const x = await setup({ restricted: true });
    const item = await upload(x.owner, { matterId: x.matter.id, filename: "walled.pdf" }, Buffer.from("walled"));
    await expect(db.withFirm(x.paraCtx, (s) => getEvidence(s, item.id))).rejects.toBeInstanceOf(NotFoundError);
  });

  it("clients upload into Client Uploads and never see firm evidence or the privileged area", async () => {
    const x = await setup();
    await db.withFirm(x.owner, (s) => addMatterMember(s, { matterId: x.matter.id, userId: x.portal.id, access: "view", acknowledgePrivilegeWaiverRisk: true }));
    const folders = await db.withFirm(x.owner, (s) => listMatterFolders(s, x.matter.id));
    const red = folders.find((f) => f.isPrivilegedArea)!;
    const evidenceFolder = folders.find((f) => f.name === "Evidence")!;

    const firmItem = await upload(x.owner, { matterId: x.matter.id, filename: "firm-work.pdf" }, Buffer.from("firm"));
    const privItem = await upload(x.owner, { matterId: x.matter.id, filename: "strategy.docx", folderId: red.id }, Buffer.from("privileged"));
    const clientItem = await upload(x.portalCtx, { matterId: x.matter.id, filename: "my-pay-stubs.pdf" }, Buffer.from("stubs"));

    expect(clientItem).toMatchObject({ folderName: "Client Uploads", source: "client_portal" });
    const visible = (await db.withFirm(x.portalCtx, (s) => listEvidence(s, x.matter.id))).map((e) => e.id);
    expect(visible).toEqual([clientItem.id]);
    expect(visible).not.toContain(firmItem.id);
    expect(visible).not.toContain(privItem.id);

    await expect(db.withFirm(x.portalCtx, (s) => startUpload(s, { matterId: x.matter.id, filename: "x.pdf", totalSize: 1, folderId: evidenceFolder.id })))
      .rejects.toThrow();
    await expect(db.withFirm(x.portalCtx, (s) => startUpload(s, { matterId: x.matter.id, filename: "x.pdf", totalSize: 1, folderId: red.id })))
      .rejects.toThrow();
    // Firm staff see everything, including what the client sent.
    const staffView = (await db.withFirm(x.paraCtx, (s) => listEvidence(s, x.matter.id))).map((e) => e.id);
    expect(staffView).toEqual(expect.arrayContaining([firmItem.id, privItem.id, clientItem.id]));
  });

  it("a client not on the matter cannot upload to it", async () => {
    const x = await setup();
    await expect(db.withFirm(x.portalCtx, (s) => startUpload(s, { matterId: x.matter.id, filename: "x.pdf", totalSize: 1 })))
      .rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("scanner protocol", () => {
  it("parses clamd replies", () => {
    expect(parseClamdReply("stream: OK\0")).toEqual({ status: "clean", detail: "No threats found" });
    expect(parseClamdReply("stream: Win.Test.EICAR_HDB-1 FOUND\0").status).toBe("infected");
    expect(parseClamdReply("INSTREAM size limit exceeded. ERROR\0").status).toBe("error");
    expect(parseClamdReply("garbage").status).toBe("error");
  });
});
