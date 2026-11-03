import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import yauzl from "yauzl";
import { BrainWorker } from "../src/brain/worker";
import type { HuisDb, RequestContext } from "../src/db/tenant";
import { addNote, askMatter } from "../src/services/brain";
import { createClient } from "../src/services/clients";
import { addClaimFromTemplate } from "../src/services/dna";
import { assembleOriginal, getUploadSession, markChunkReceived, newEvidenceId, recordEvidence, startUpload, storeChunk } from "../src/services/evidence";
import { addMatterMember, createMatter, removeMatterMember } from "../src/services/matters";
import { canExportMatter, csv, prepareMatterExport, safeSegment, streamMatterExport, uniquePath } from "../src/services/matterExport";
import { disableUser, inviteUser } from "../src/services/users";
import { MasterKeyProvider } from "../src/storage/encryption";
import type { MalwareScanner } from "../src/storage/scanner";
import { EvidenceVault, LocalObjectStore } from "../src/storage/store";
import { EvidenceProcessor } from "../src/worker/processor";
import { createTestDatabase, newFirm, type TestDatabase } from "./helpers";

let t: TestDatabase;
let db: HuisDb;
let vault: EvidenceVault;
let vaultDir: string;
let processor: EvidenceProcessor;
let brain: BrainWorker;
const scanner: MalwareScanner = {
  name: "test",
  async scan(stream) {
    let text = "";
    for await (const c of stream) text += Buffer.from(c as Buffer).toString("latin1");
    return text.includes("EICAR-TEST") ? { status: "infected", detail: "Test signature" } : { status: "clean", detail: "No threats found" };
  },
};

beforeAll(async () => {
  t = await createTestDatabase();
  db = t.db;
  vaultDir = await mkdtemp(path.join(os.tmpdir(), "huis-export-vault-"));
  vault = new EvidenceVault(new LocalObjectStore(vaultDir), new MasterKeyProvider(randomBytes(32).toString("base64")));
  processor = new EvidenceProcessor(t.worker, vault, scanner);
  brain = new BrainWorker(t.worker);
});
afterAll(async () => {
  await t?.drop();
  if (vaultDir) await rm(vaultDir, { recursive: true, force: true });
});

async function upload(ctx: RequestContext, matterId: string, filename: string, content: Buffer) {
  const session = await db.withFirm(ctx, (s) => startUpload(s, { matterId, filename, totalSize: content.length }));
  for (let i = 0; i < session.chunkCount; i++) {
    await storeChunk(vault, session, i, content.subarray(i * session.chunkSize, (i + 1) * session.chunkSize));
    await db.withFirm(ctx, (s) => markChunkReceived(s, session.id, i));
  }
  const fresh = await db.withFirm(ctx, (s) => getUploadSession(s, session.id));
  const id = newEvidenceId();
  const stored = await assembleOriginal(vault, fresh, id);
  return db.withFirm(ctx, (s) => recordEvidence(s, fresh, id, stored));
}

async function setup() {
  const f = await newFirm(db);
  const x = await db.withFirm(f.owner, async (s) => {
    const client = await createClient(s, { kind: "person", displayName: "Pat Smith" });
    const attorney = await inviteUser(s, { email: `a@${f.slug}.example`, fullName: "Avery Attorney", role: "attorney", locationId: f.locationId });
    const para = await inviteUser(s, { email: `p@${f.slug}.example`, fullName: "Pat Para", role: "paralegal", locationId: f.locationId });
    const reader = await inviteUser(s, { email: `r@${f.slug}.example`, fullName: "Rae Reader", role: "read_only", locationId: f.locationId });
    const admin = await inviteUser(s, { email: `ad@${f.slug}.example`, fullName: "Ada Admin", role: "firm_admin", locationId: f.locationId });
    const portal = await inviteUser(s, { email: `c@${f.slug}.example`, fullName: "Casey Client", role: "client", locationId: f.locationId });
    const matter = await createMatter(s, { title: "Smith v. Acme", clientId: client.id, leadAttorneyId: f.ownerUserId, jurisdictionState: "UT" });
    const walled = await createMatter(s, { title: "Walled", clientId: client.id, leadAttorneyId: f.ownerUserId, jurisdictionState: "UT", restricted: true });
    return { attorney, para, reader, admin, portal, matter, walled };
  });
  await db.withFirm(f.owner, (s) => addMatterMember(s, { matterId: x.matter.id, userId: x.para.id, access: "edit" }));
  await db.withFirm(f.owner, (s) => addMatterMember(s, { matterId: x.matter.id, userId: x.portal.id, access: "view", acknowledgePrivilegeWaiverRisk: true }));
  const ctx = (id: string): RequestContext => ({ firmId: f.firmId, userId: id });
  return { ...f, ...x, ctx };
}

/** Builds the export as `ctx` and reads the ZIP back: path → content. */
async function exportAs(ctx: RequestContext, matterId: string, ack = true) {
  const plan = await db.withFirm(ctx, (s) => prepareMatterExport(s, matterId, ack));
  const out = streamMatterExport(plan, { db, vault, ctx });
  const chunks: Buffer[] = [];
  for await (const c of out as Readable) chunks.push(c as Buffer);
  const zipBuf = Buffer.concat(chunks);
  const files = new Map<string, Buffer>();
  await new Promise<void>((resolve, reject) => {
    yauzl.fromBuffer(zipBuf, { lazyEntries: true }, (err, zf) => {
      if (err || !zf) return reject(err);
      zf.on("entry", (e: yauzl.Entry) => {
        zf.openReadStream(e, (er, rs) => {
          if (er || !rs) return reject(er);
          const parts: Buffer[] = [];
          rs.on("data", (d: Buffer) => parts.push(d));
          rs.on("end", () => { files.set(e.fileName, Buffer.concat(parts)); zf.readEntry(); });
        });
      });
      zf.on("end", () => resolve());
      zf.on("error", reject);
      zf.readEntry();
    });
  });
  return { plan, files };
}

const LETTER = "Termination letter. Your employment is terminated effective April 18, 2026, after your FMLA request.";

describe("exporting a Matter", () => {
  it("contains every clean original exactly, its text, custody, notes, my questions, Case DNA, a manifest and checksums for everything", async () => {
    const x = await setup();
    const letter = await upload(x.owner, x.matter.id, "termination.txt", Buffer.from(LETTER));
    const binary = randomBytes(5000);
    const bin = await upload(x.owner, x.matter.id, "photo.bin", binary);
    await upload(x.owner, x.matter.id, "virus.txt", Buffer.from("X5O!P%@AP EICAR-TEST"));
    await processor.drain();
    while (await brain.indexOnce()) { /* index */ }
    await db.withFirm(x.owner, (s) => addNote(s, x.matter.id, { title: "Strategy", body: "Retaliation timeline is strong." }));
    await db.withFirm(x.owner, (s) => askMatter(s, x.matter.id, "When was she terminated?"));
    await db.withFirm(x.ctx(x.para.id), (s) => askMatter(s, x.matter.id, "Paralegal's private question about damages"));
    await db.withFirm(x.owner, (s) => addClaimFromTemplate(s, x.matter.id, "fmla_retaliation"));

    const { plan, files } = await exportAs(x.owner, x.matter.id);
    const names = [...files.keys()];
    expect(names).toEqual(expect.arrayContaining(["README.txt", "matter.json", "evidence/manifest.csv", "evidence/custody.json", "evidence/marks.json",
      "matter-brain/notes.json", "matter-brain/my-questions.json", "case-dna.json", "SHA256SUMS.txt"]));
    expect(files.get("README.txt")!.toString()).toMatch(/PRIVILEGED & CONFIDENTIAL — ATTORNEY WORK PRODUCT/);
    // Originals exactly as received.
    const letterPath = names.find((n) => n.endsWith("/termination.txt") && n.startsWith("evidence/files/"))!;
    expect(files.get(letterPath)!.toString()).toBe(LETTER);
    const binPath = names.find((n) => n.endsWith("/photo.bin"))!;
    expect(files.get(binPath)!.equals(binary)).toBe(true);
    expect(names.some((n) => n.startsWith("evidence/text/") && n.endsWith("termination.txt.txt"))).toBe(true);
    // The infected file is listed, never included.
    expect(names.some((n) => n.includes("virus"))).toBe(false);
    expect(files.get("evidence/manifest.csv")!.toString()).toMatch(/virus\.txt.*Not included/);
    // Checksums cover every other file and match.
    const sums = files.get("SHA256SUMS.txt")!.toString().trim().split("\n").map((l) => [l.slice(66), l.slice(0, 64)] as const);
    expect(sums.map(([p]) => p).sort()).toEqual(names.filter((n) => n !== "SHA256SUMS.txt").sort());
    for (const [p, hex] of sums) expect(createHash("sha256").update(files.get(p)!).digest("hex")).toBe(hex);
    // Only the exporter's own questions.
    const qa = files.get("matter-brain/my-questions.json")!.toString();
    expect(qa).toContain("When was she terminated?");
    expect(qa).not.toContain("Paralegal's private question");
    expect(files.get("matter-brain/notes.json")!.toString()).toContain("Retaliation timeline is strong.");
    expect(JSON.parse(files.get("case-dna.json")!.toString()).nodes.some((n: { label: string }) => n.label === "FMLA retaliation")).toBe(true);
    // Custody records the export for each included item; the audit log records no content.
    const exported = await t.admin.query("SELECT evidence_id FROM huis.evidence_custody_events WHERE event = 'exported' AND details->>'export_id' = $1", [plan.exportId]);
    expect(exported.rows.map((r) => r.evidence_id).sort()).toEqual([letter.id, bin.id].sort());
    const custody = JSON.parse(files.get("evidence/custody.json")!.toString());
    expect(custody.every((c: { chain: string }) => c.chain === "intact")).toBe(true);
    const audit = await t.admin.query("SELECT metadata::text AS m FROM huis.audit_events WHERE firm_id = $1 AND action = 'matter.exported'", [x.firmId]);
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].m).not.toMatch(/terminat|Retaliation/i);
  });

  it("only the Matter's owner or a firm administrator who can see it can export, after confirming", async () => {
    const x = await setup();
    await upload(x.owner, x.matter.id, "termination.txt", Buffer.from(LETTER));
    await processor.drain();
    await expect(db.withFirm(x.owner, (s) => prepareMatterExport(s, x.matter.id, false))).rejects.toThrow(/store the export securely/);
    for (const who of [x.para, x.reader, x.portal, x.attorney]) {
      await expect(db.withFirm(x.ctx(who.id), (s) => prepareMatterExport(s, x.matter.id, true))).rejects.toThrow();
      expect(await db.withFirm(x.ctx(who.id), (s) => canExportMatter(s, x.matter.id).catch(() => false))).toBe(false);
    }
    expect(await db.withFirm(x.ctx(x.admin.id), (s) => canExportMatter(s, x.matter.id))).toBe(true);
    await exportAs(x.ctx(x.admin.id), x.matter.id);
    // An administrator outside an ethical wall can't export the walled Matter.
    await expect(db.withFirm(x.ctx(x.admin.id), (s) => prepareMatterExport(s, x.walled.id, true))).rejects.toThrow();
    // Nobody can record exports directly.
    await expect(db.withFirm(x.ctx(x.para.id), (s) => s.client.query("SELECT huis.record_matter_export($1, gen_random_uuid())", [x.matter.id]))).rejects.toThrow(/permission/i);
    // The owner of a Matter (not only the firm owner) can export it.
    await db.withFirm(x.owner, (s) => addMatterMember(s, { matterId: x.matter.id, userId: x.attorney.id, access: "owner" }));
    expect(await db.withFirm(x.ctx(x.attorney.id), (s) => canExportMatter(s, x.matter.id))).toBe(true);
  });

  it("file names are made safe and unique, and spreadsheet cells can't run as formulas", async () => {
    const x = await setup();
    // Uploads already refuse most of these names; set them directly to test the export on its own.
    const names = ["../../etc/passwd", "con.txt", "a\\b:c*?.txt", "same.txt", "SAME.txt", "=HYPERLINK(\"http://evil\").txt", ".hidden"];
    for (let i = 0; i < names.length; i++) {
      const item = await upload(x.owner, x.matter.id, `file${i}.txt`, Buffer.from(`content ${i}`));
      await t.admin.query(`SET session_replication_role = replica; UPDATE huis.evidence_items SET original_filename = $q$${names[i]}$q$ WHERE id = '${item.id}'; SET session_replication_role = origin;`);
    }
    await processor.drain();
    const { files } = await exportAs(x.owner, x.matter.id);
    const originals = [...files.keys()].filter((n) => n.startsWith("evidence/files/"));
    expect(originals).toHaveLength(7);
    for (const n of originals) {
      expect(n.split("/").every((seg) => seg !== ".." && seg !== "." && seg.length > 0)).toBe(true);
      expect(n).not.toMatch(/[\\:*?"<>|]/);
    }
    expect(originals.some((n) => n.endsWith("/_con.txt"))).toBe(true);
    expect(new Set(originals.map((n) => n.toLowerCase())).size).toBe(7);
    const manifest = files.get("evidence/manifest.csv")!.toString();
    expect(manifest).toContain(`"'=HYPERLINK(""http://evil"").txt"`);
    expect(safeSegment("")).toBe("unnamed");
    expect(safeSegment("Smith v. Acme — “notice”…")).toBe("Smith v. Acme - _notice_"); // (Windows forbids names ending in a dot)
    expect(safeSegment("x".repeat(500) + ".pdf").length).toBeLessThanOrEqual(120);
  });

  it("an original that fails its integrity check stops the export instead of producing a bad copy", async () => {
    const x = await setup();
    const item = await upload(x.owner, x.matter.id, "termination.txt", Buffer.from(LETTER));
    await processor.drain();
    // Tamper with the stored (encrypted) file.
    const walk = async (dir: string): Promise<string[]> => (await Promise.all((await readdir(dir, { withFileTypes: true })).map(
      (e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)])))).flat();
    const stored = (await walk(vaultDir)).filter((p) => p.includes(item.id) && p.endsWith("original"));
    expect(stored.length).toBe(1);
    const bytes = await readFile(stored[0]!);
    bytes[bytes.length - 20] = (bytes[bytes.length - 20] ?? 0) ^ 0xff;
    await writeFile(stored[0]!, bytes);
    expect((await stat(stored[0]!)).size).toBe(bytes.length);
    await expect(exportAs(x.owner, x.matter.id)).rejects.toThrow();
  });
  // ---- Review 10 regressions ----------------------------------------------------------------------
  it("access and scan status are checked again for every item while the export downloads (review 10)", async () => {
    const x = await setup();
    await db.withFirm(x.owner, (s) => addMatterMember(s, { matterId: x.matter.id, userId: x.attorney.id, access: "owner" }));
    const a = await upload(x.owner, x.matter.id, "a.txt", Buffer.from(LETTER));
    await upload(x.owner, x.matter.id, "b.txt", Buffer.from("Second item."));
    await processor.drain();
    const drain = async (out: Readable) => { for await (const _ of out) { /* read */ } };
    const plan = () => db.withFirm(x.ctx(x.attorney.id), (s) => prepareMatterExport(s, x.matter.id, true));

    // Normal export: each item's text comes right after its original.
    const { files } = await exportAs(x.ctx(x.attorney.id), x.matter.id);
    const order = [...files.keys()].filter((n) => n.startsWith("evidence/files/") || n.startsWith("evidence/text/"));
    expect(order.map((n) => n.split("/")[1])).toEqual(["files", "text", "files", "text"]);

    // 1. An item found infected after planning: the download stops.
    let p = await plan();
    await t.admin.query(`SET session_replication_role = replica; UPDATE huis.evidence_items SET status = 'infected' WHERE id = '${a.id}'; SET session_replication_role = origin;`);
    await expect(drain(streamMatterExport(p, { db, vault, ctx: x.ctx(x.attorney.id) }))).rejects.toThrow(/access to .* changed/);
    await t.admin.query(`SET session_replication_role = replica; UPDATE huis.evidence_items SET status = 'clean' WHERE id = '${a.id}'; SET session_replication_role = origin;`);

    // 2. The exporter is taken off the Matter after planning: the download stops.
    p = await plan();
    await db.withFirm(x.owner, (s) => removeMatterMember(s, x.matter.id, x.attorney.id));
    await expect(drain(streamMatterExport(p, { db, vault, ctx: x.ctx(x.attorney.id) }))).rejects.toThrow();

    // 3. The exporter is disabled after planning: the download stops.
    await db.withFirm(x.owner, (s) => addMatterMember(s, { matterId: x.matter.id, userId: x.attorney.id, access: "owner" }));
    p = await plan();
    await db.withFirm(x.owner, (s) => disableUser(s, x.attorney.id));
    await expect(drain(streamMatterExport(p, { db, vault, ctx: x.ctx(x.attorney.id) }))).rejects.toThrow();
  });

  it("tricky names: invisible and direction characters, long names, Windows look-alikes and device names (review 10)", () => {
    expect(safeSegment("invoice\u202Efdp.exe")).toBe("invoicefdp.exe");
    expect(safeSegment("a\u200Bb\uFEFFc\u2066.pdf")).toBe("abc.pdf");
    expect(safeSegment("bad\ud800half.txt")).toBe("bad\ufffdhalf.txt");
    // Shortening never leaves a trailing dot or space, or half an emoji.
    const dots = safeSegment(`${"a".repeat(118)}. .${"b".repeat(20)}`);
    expect(dots).not.toMatch(/[ .]$/);
    const emoji = safeSegment("😀".repeat(200));
    expect(Array.from(emoji).length).toBeLessThanOrEqual(120);
    expect(emoji).toBe(emoji.toWellFormed());
    const long = safeSegment(`${"x".repeat(300)}.pdf`);
    expect(long.endsWith(".pdf")).toBe(true);
    expect(Array.from(long).length).toBeLessThanOrEqual(120);
    // Device names Windows reserves.
    for (const n of ["COM¹.txt", "lpt².log", "CONIN$", "conout$.txt", "nul", "Com3.pdf"]) expect(safeSegment(n).startsWith("_")).toBe(true);
    expect(safeSegment("console.txt")).toBe("console.txt");
    // Names Windows or macOS treat as the same file get different names.
    const used = new Set<string>();
    const a = uniquePath(used, "f", "Σίσυφος.txt");
    const b = uniquePath(used, "f", "ΣΊΣΥΦΟΣ.txt");
    const c = uniquePath(used, "f", "σίσυφοσ.txt");
    const d = uniquePath(used, "f", "ﬁle.txt");
    const e = uniquePath(used, "f", "FILE.txt");
    expect(new Set([a, b, c]).size).toBe(3);
    expect(b).toBe("f/ΣΊΣΥΦΟΣ (2).txt");
    expect(e).toBe("f/FILE (2).txt");
    expect(d).toBe("f/ﬁle.txt");
  });

  it("every spreadsheet cell is quoted and formula-like values are defused however they start (review 10)", () => {
    for (const v of ["=1+1", " =1+1", "\n=cmd", "\t+1", "\u200B@SUM(A1)", "＝HYPERLINK(1)", "＋1", "－1", "＠x", "-2"]) {
      expect(csv(v)).toBe(`"'${v.replace(/"/g, '""')}"`);
    }
    expect(csv("x;=cmd|' /C calc'!A0")).toBe(`"x;=cmd|' /C calc'!A0"`);
    expect(csv('say "hi"')).toBe('"say ""hi"""');
    expect(csv(null)).toBe('""');
  });

  it("recording an export always writes its audit entry, and an export id can be used only once (review 10)", async () => {
    const x = await setup();
    await upload(x.owner, x.matter.id, "a.txt", Buffer.from(LETTER));
    await processor.drain();
    const id = randomUUID();
    const n = await db.withFirm(x.owner, async (s) => (await s.client.query<{ n: number }>("SELECT huis.record_matter_export($1, $2) AS n", [x.matter.id, id])).rows[0]!.n);
    expect(n).toBe(1);
    const audit = await t.admin.query("SELECT actor_user_id, metadata FROM huis.audit_events WHERE action = 'matter.exported' AND metadata->>'export_id' = $1", [id]);
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].metadata.items).toBe("1");
    await expect(db.withFirm(x.owner, (s) => s.client.query("SELECT huis.record_matter_export($1, $2)", [x.matter.id, id]))).rejects.toThrow(/already used/);
    const custody = await t.admin.query("SELECT count(*)::int AS n FROM huis.evidence_custody_events WHERE event = 'exported' AND details->>'export_id' = $1", [id]);
    expect(custody.rows[0].n).toBe(1);
  });
});
