/**
 * Phase 2 part 2: text extraction, OCR, email and archive splitting, search.
 * Uses real sample files generated here (and public sample Outlook files).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HuisDb, RequestContext } from "../src/db/tenant";
import { extract } from "../src/extract/formats";
import { extractInSandbox, isolationArgs, sandboxMode, verifyChildren } from "../src/extract/sandbox";
import type { ExtractInput } from "../src/extract/types";
import { createClient } from "../src/services/clients";
import {
  assembleOriginal, getEmailHeaders, getEvidence, getEvidenceText, getUploadSession, listContainedItems,
  listEvidence, markChunkReceived, moveEvidence, newEvidenceId, recordEvidence, startUpload, storeChunk,
} from "../src/services/evidence";
import { addMatterMember, createMatter, listMatterFolders } from "../src/services/matters";
import { HIT_END, HIT_START, searchEvidence } from "../src/services/search";
import { inviteUser } from "../src/services/users";
import { MasterKeyProvider } from "../src/storage/encryption";
import { detectFileType } from "../src/storage/filetype";
import type { MalwareScanner } from "../src/storage/scanner";
import { EvidenceVault, LocalObjectStore } from "../src/storage/store";
import { EvidenceProcessor } from "../src/worker/processor";
import { createTestDatabase, newFirm, type TestDatabase } from "./helpers";

const FIXTURES = path.join(__dirname, "fixtures");
let t: TestDatabase;
let db: HuisDb;
let dir: string;      // generated sample files
let vaultDir: string;
let vault: EvidenceVault;
let processor: EvidenceProcessor;
const files: Record<string, string> = {};

const scanner: MalwareScanner = {
  name: "TestScanner",
  async scan(content) {
    let all = "";
    for await (const c of content) all += (c as Buffer).toString("latin1");
    return all.includes("EICAR-TEST") ? { status: "infected", detail: "Threat detected: test" } : { status: "clean", detail: "No threats found" };
  },
};

/** A minimal valid PDF with real text. */
function makePdf(lines: string[]): Buffer {
  const content = ["BT", "/F1 14 Tf", "72 720 Td", "18 TL",
    ...lines.map((l) => `(${l.replace(/[()\\]/g, "\\$&")}) Tj T*`), "ET"].join("\n");
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** Width, height and colour channels of a JPEG. */
function jpegInfo(b: Buffer): { width: number; height: number; comps: number } {
  let i = 2;
  while (i < b.length) {
    const marker = b[i + 1]!;
    const len = b.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc2) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7), comps: b[i + 9]! };
    i += 2 + len;
  }
  throw new Error("not a JPEG");
}

/** An image-only PDF (like a scanner makes) wrapping a JPEG page image. */
function makeImagePdf(jpeg: Buffer): Buffer {
  const { width, height, comps } = jpegInfo(jpeg);
  const content = `q 612 0 0 792 0 0 cm /Im1 Do Q`;
  const parts: (string | Buffer)[] = [];
  const offsets: number[] = [];
  let len = 0;
  const push = (x: string | Buffer) => { parts.push(x); len += Buffer.byteLength(x as string); };
  push("%PDF-1.4\n");
  const objs: (string | [string, Buffer])[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /XObject << /Im1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    [`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /${comps === 1 ? "DeviceGray" : "DeviceRGB"} /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`, jpeg],
  ];
  objs.forEach((o, i) => {
    offsets.push(len);
    push(`${i + 1} 0 obj\n`);
    if (typeof o === "string") push(o);
    else { push(o[0]); push(o[1]); push("\nendstream"); }
    push("\nendobj\n");
  });
  const xref = len;
  push(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`);
  push(`trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(parts.map((p) => (typeof p === "string" ? Buffer.from(p, "latin1") : p)));
}

const sh = (cmd: string, args: string[]) => execFileSync(cmd, args, { stdio: "ignore", timeout: 180_000 });

beforeAll(async () => {
  t = await createTestDatabase();
  db = t.db;
  dir = await mkdtemp(path.join(os.tmpdir(), "huis-samples-"));
  vaultDir = await mkdtemp(path.join(os.tmpdir(), "huis-xvault-"));
  vault = new EvidenceVault(new LocalObjectStore(vaultDir), new MasterKeyProvider(randomBytes(32).toString("base64")));
  processor = new EvidenceProcessor(t.worker, vault, scanner);

  // Text PDF
  files.pdf = path.join(dir, "termination-letter.pdf");
  await writeFile(files.pdf, makePdf([
    "Notice of termination", "The employee was informed on April 18 that",
    "her position was eliminated after the FMLA request.", "Signed, Human Resources",
  ]));
  // Scanned page: render the PDF to an image, then wrap the image in an image-only PDF.
  sh("pdftoppm", ["-r", "200", "-png", "-singlefile", files.pdf, path.join(dir, "scan")]);
  files.png = path.join(dir, "scan.png");
  sh("pdftoppm", ["-r", "200", "-gray", "-jpeg", "-singlefile", files.pdf, path.join(dir, "scanjpg")]);
  files.scannedPdf = path.join(dir, "scanned.pdf");
  await writeFile(files.scannedPdf, makeImagePdf(await readFile(path.join(dir, "scanjpg.jpg"))));
  // Word and Excel via LibreOffice
  await writeFile(path.join(dir, "memo.txt"), "Settlement memo\nThe client authorized a demand of 125000 dollars.\n");
  sh("soffice", [`-env:UserInstallation=file://${dir}/lo`, "--headless", "--convert-to", "docx", "--outdir", dir, path.join(dir, "memo.txt")]);
  files.docx = path.join(dir, "memo.docx");
  await writeFile(path.join(dir, "damages.csv"), "Item,Amount\nLost wages,48000\nMedical bills,7350\n");
  sh("soffice", [`-env:UserInstallation=file://${dir}/lo`, "--headless", "--convert-to", "xlsx", "--outdir", dir, path.join(dir, "damages.csv")]);
  files.xlsx = path.join(dir, "damages.xlsx");
  // Email with two attachments (a PDF and a text file)
  const pdfB64 = (await readFile(files.pdf)).toString("base64").replace(/.{76}/g, "$&\r\n");
  files.eml = path.join(dir, "hr-email.eml");
  await writeFile(files.eml, [
    "From: Cindy Manager <cindy@acme.example>",
    "To: Tracy Employee <tracy@example.com>",
    "Cc: HR <hr@acme.example>",
    "Subject: Re: March meeting and your surgery",
    "Date: Fri, 18 Apr 2025 09:15:00 -0600",
    "Message-ID: <abc123@acme.example>",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="BOUND"',
    "",
    "--BOUND",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "We discussed your surgery at the March meeting. HR acknowledged the leave request.",
    "--BOUND",
    'Content-Type: application/pdf; name="letter.pdf"',
    "Content-Transfer-Encoding: base64",
    'Content-Disposition: attachment; filename="letter.pdf"',
    "",
    pdfB64,
    "--BOUND",
    'Content-Type: text/plain; name="../../notes.txt"',
    'Content-Disposition: attachment; filename="../../notes.txt"',
    "",
    "Private notes about the PTO request.",
    "--BOUND--",
    "",
  ].join("\r\n"));
  // Mailbox with two messages
  files.mbox = path.join(dir, "export.mbox");
  await writeFile(files.mbox, [
    "From cindy@acme.example Mon Apr 14 10:00:00 2025",
    "From: cindy@acme.example", "To: tracy@example.com", "Subject: First message", "", "Body one about payroll.", "",
    "From hr@acme.example Tue Apr 15 10:00:00 2025",
    "From: hr@acme.example", "To: tracy@example.com", "Subject: Second message", "", "Body two about benefits.", "",
  ].join("\n"));
  // ZIP: normal files, a path-traversal name, a nested zip and a zip bomb.
  files.zip = path.join(dir, "production.zip");
  files.bomb = path.join(dir, "bomb.zip");
  const py = `
import zipfile, sys
with zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("Production/DEF-000001.txt", "Defendant produced document about the termination decision.")
    z.writestr("../../escape.txt", "path traversal attempt")
    z.write(sys.argv[3], "Production/letter.pdf")
with zipfile.ZipFile(sys.argv[2], "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("small.txt", "fine")
    z.writestr("huge.bin", b"\\0" * (150 * 1024 * 1024))
`;
  execFileSync("python3", ["-c", py, files.zip, files.bomb, files.pdf], { timeout: 120_000 });
  files.wav = path.join(dir, "voicemail.wav");
  sh("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", files.wav]);
});

afterAll(async () => {
  await t?.drop();
  for (const d of [dir, vaultDir]) if (d) await rm(d, { recursive: true, force: true });
});

async function run(file: string, filename = path.basename(file)) {
  const out = await mkdtemp(path.join(os.tmpdir(), "huis-xo-"));
  const head = (await readFile(file)).subarray(0, 4096);
  const input: ExtractInput = { inputPath: file, outDir: out, filename, detectedType: detectFileType(head).label, depth: 0 };
  return { result: await extract(input), out };
}

describe("extractors (real files)", () => {
  it("reads text PDFs", async () => {
    const { result } = await run(files.pdf!);
    expect(result).toMatchObject({ status: "done", method: "native", pages: 1 });
    expect(result.text).toMatch(/position was eliminated after the FMLA request/);
  });

  it("reads scanned PDFs with OCR", async () => {
    const { result } = await run(files.scannedPdf!);
    expect(result.method).toBe("ocr");
    expect(result.text.toLowerCase()).toMatch(/termination/);
    expect(result.text.toLowerCase()).toMatch(/fmla/);
  });

  it("reads photos of documents with OCR", async () => {
    const { result } = await run(files.png!);
    expect(result).toMatchObject({ method: "ocr", status: "done" });
    expect(result.text.toLowerCase()).toMatch(/human resources/);
  });

  it("reads Word documents and spreadsheets", async () => {
    expect((await run(files.docx!)).result.text).toMatch(/demand of 125000 dollars/);
    const x = (await run(files.xlsx!)).result;
    expect(x.text).toMatch(/Lost wages\t48000/);
    expect(x.text).toMatch(/Medical bills\t7350/);
  });

  it("splits emails into headers, body and attachments, with safe attachment names", async () => {
    const { result } = await run(files.eml!);
    expect(result.email).toMatchObject({
      from: "Cindy Manager <cindy@acme.example>", to: ["Tracy Employee <tracy@example.com>"], cc: ["HR <hr@acme.example>"],
      subject: "Re: March meeting and your surgery", date: "2025-04-18T15:15:00.000Z",
    });
    expect(result.text).toMatch(/We discussed your surgery at the March meeting/);
    expect(result.children.map((c) => c.filename)).toEqual(["letter.pdf", "notes.txt"]);
  });

  it("reads Outlook .msg files and their attachments", async () => {
    const { result } = await run(path.join(FIXTURES, "msg/attachmentsOrder.msg"));
    expect(result.email?.subject).toBe("Attachments order");
    expect(result.children.map((c) => c.filename)).toEqual(["A.docx", "B.docx", "C.docx", "D.docx"]);
    const t1 = (await run(path.join(FIXTURES, "msg/test1.msg"))).result;
    expect(t1.email).toMatchObject({ to: ["to@example.com"], cc: ["cc@example.com"] });
  });

  it("rejects a deliberately damaged Outlook file safely", async () => {
    await expect(run(path.join(FIXTURES, "msg/cyclicFatRing.msg"))).rejects.toThrow();
  });

  it("splits mailboxes into one email per message", async () => {
    const { result } = await run(files.mbox!);
    expect(result.children).toHaveLength(2);
    expect(await readFile(result.children[1]!.path, "utf8")).toMatch(/Subject: Second message/);
  });

  it("unpacks archives, keeps the inside path for the record, never writes outside its folder, and refuses zip bombs", async () => {
    const { result, out } = await run(files.zip!);
    expect(result.children.map((c) => c.containerPath).sort()).toEqual(["../../escape.txt", "Production/DEF-000001.txt", "Production/letter.pdf"]);
    expect(result.children.map((c) => c.filename)).toContain("escape.txt");
    for (const c of result.children) expect(path.dirname(c.path)).toBe(out);
    const bomb = (await run(files.bomb!)).result;
    expect(bomb.status).toBe("partial");
    expect(bomb.children.map((c) => c.filename)).toEqual(["small.txt"]);
    expect(bomb.text).toMatch(/huge\.bin \(unsafe size\)/);
  });

  it("holds audio/video for an approved transcription provider", async () => {
    const { result } = await run(files.wav!);
    expect(result.status).toBe("needs_provider");
  });

  it("runs each file in a sandbox: unprivileged, no network, can't see the worker or its secrets", async () => {
    const mode = sandboxMode();
    if (mode !== "namespaces") {
      // Development/CI machines without namespace support run unsandboxed only when explicitly allowed.
      expect(process.env.HUIS_ALLOW_UNSANDBOXED_EXTRACTION).toBe("1");
      return;
    }
    const work = await mkdtemp(path.join(os.tmpdir(), "huis-x-test-"));
    const out = path.join(work, "out");
    await mkdir(out);
    await copyFile(files.pdf!, path.join(work, "input"));
    const r = await extractInSandbox({ inputPath: path.join(work, "input"), outDir: out, filename: "a.pdf", detectedType: "PDF", depth: 0 }, work);
    expect(r.text).toMatch(/Notice of termination/);

    // Probe the sandbox directly with a secret in this (parent) process.
    process.env.HUIS_STORAGE_MASTER_KEY = "SHOULD-NOT-LEAK";
    const secretFile = path.join(vaultDir, "secret-probe.txt");
    await writeFile(secretFile, "root-only", { mode: 0o600 });
    const probe = spawnSync("unshare", [...isolationArgs(), "sh", "-c",
      `id -u; cat /proc/*/environ 2>/dev/null | tr '\\0' '\\n' | grep -c SHOULD-NOT-LEAK; ls /proc | grep -cE '^[0-9]+$'; cat ${secretFile} 2>&1 | head -1; getent hosts github.com >/dev/null && echo NET || echo NONET`,
    ], { encoding: "utf8", env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } as unknown as NodeJS.ProcessEnv });
    delete process.env.HUIS_STORAGE_MASTER_KEY;
    const [uid, leaks, procs, fileRead, net] = probe.stdout.trim().split("\n");
    expect(uid).toBe("65534");
    expect(leaks).toBe("0");
    expect(Number(procs)).toBeLessThan(10);
    expect(fileRead).toMatch(/Permission denied/);
    expect(net).toBe("NONET");
    await rm(work, { recursive: true, force: true });
  });

  it("rejects contained files that are links pointing elsewhere", async () => {
    const out = await mkdtemp(path.join(os.tmpdir(), "huis-link-"));
    await symlink("/etc/passwd", path.join(out, "att-1"));
    await expect(verifyChildren({ status: "done", detail: "", text: "", method: "native", pages: null, email: null,
      children: [{ path: path.join(out, "att-1"), filename: "passwd", containerPath: "x", declaredType: null }] }, out))
      .rejects.toThrow(/unexpected/);
    await expect(verifyChildren({ status: "done", detail: "", text: "", method: "native", pages: null, email: null,
      children: [{ path: "/etc/passwd", filename: "passwd", containerPath: "x", declaredType: null }] }, out))
      .rejects.toThrow(/unexpected/);
    await rm(out, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Full pipeline: upload → scan → extract → children → search, with privilege
// ---------------------------------------------------------------------------
async function upload(ctx: RequestContext, matterId: string, file: string, filename = path.basename(file), folderId?: string) {
  const content = await readFile(file);
  const session = await db.withFirm(ctx, (s) => startUpload(s, { matterId, filename, totalSize: content.length, folderId }));
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
    const client = await createClient(s, { kind: "person", displayName: "Client" });
    const para = await inviteUser(s, { email: `p@${f.slug}.example`, fullName: "Pat Para", role: "paralegal", locationId: f.locationId });
    const portal = await inviteUser(s, { email: `c@${f.slug}.example`, fullName: "Casey Client", role: "client", locationId: f.locationId });
    const matter = await createMatter(s, { title: "Tracy v. Acme", clientId: client.id, leadAttorneyId: f.ownerUserId, jurisdictionState: "UT" });
    const walled = await createMatter(s, { title: "Walled matter", clientId: client.id, leadAttorneyId: f.ownerUserId, jurisdictionState: "UT", restricted: true });
    return { client, para, portal, matter, walled };
  });
  return { ...f, ...x, paraCtx: { firmId: f.firmId, userId: x.para.id }, portalCtx: { firmId: f.firmId, userId: x.portal.id } };
}

describe("pipeline: upload, scan, extract, split, search", () => {
  it("an uploaded email becomes searchable, and its attachments become scanned, searchable items with custody", async () => {
    const x = await setup();
    const email = await upload(x.owner, x.matter.id, files.eml!);
    await processor.drain();

    const parent = await db.withFirm(x.owner, (s) => getEvidence(s, email.id));
    expect(parent).toMatchObject({ status: "clean", extractionStatus: "done", childCount: 2 });
    const headers = await db.withFirm(x.owner, (s) => getEmailHeaders(s, email.id));
    expect(headers).toMatchObject({ from: "Cindy Manager <cindy@acme.example>", subject: "Re: March meeting and your surgery", attachmentCount: 2 });

    const kids = await db.withFirm(x.owner, (s) => listContainedItems(s, email.id));
    expect(kids.map((k) => k.originalFilename).sort()).toEqual(["letter.pdf", "notes.txt"]);
    for (const k of kids) {
      expect(k).toMatchObject({ status: "clean", source: "extracted", parentId: email.id, folderName: "Evidence" });
    }
    const letter = kids.find((k) => k.originalFilename === "letter.pdf")!;
    expect((await db.withFirm(x.owner, (s) => getEvidenceText(s, letter.id)))?.content).toMatch(/FMLA request/);

    const hits = await db.withFirm(x.owner, (s) => searchEvidence(s, { q: "FMLA" }));
    expect(hits.map((h) => h.evidenceId)).toContain(letter.id);
    const hit = hits.find((h) => h.evidenceId === letter.id)!;
    expect(hit.snippet).toContain(`${HIT_START}FMLA${HIT_END}`);
    const phrase = await db.withFirm(x.owner, (s) => searchEvidence(s, { q: '"March meeting"' }));
    expect(phrase.map((h) => h.evidenceId)).toContain(email.id);

    const custody = (await db.withFirm(x.owner, async (s) => (await s.client.query(
      "SELECT event FROM huis.evidence_custody_events WHERE evidence_id = $1 ORDER BY chain_seq", [letter.id])).rows.map((r) => r.event)));
    expect(custody.slice(0, 3)).toEqual(["extracted", "integrity_verified", "scanned_clean"]);
  });

  it("archives unpack into items; zip bombs are refused; a stored file can't escape its matter", async () => {
    const x = await setup();
    const zip = await upload(x.owner, x.matter.id, files.zip!);
    await processor.drain();
    const kids = await db.withFirm(x.owner, (s) => listContainedItems(s, zip.id));
    expect(kids.map((k) => k.containerPath).sort()).toEqual(["../../escape.txt", "Production/DEF-000001.txt", "Production/letter.pdf"]);
    const keys = (await t.admin.query("SELECT storage_key FROM huis.evidence_items WHERE parent_id = $1", [zip.id])).rows.map((r) => r.storage_key);
    for (const k of keys) expect(k.startsWith(`firm/${x.firmId}/matter/${x.matter.id}/evidence/`)).toBe(true);
    const hits = await db.withFirm(x.owner, (s) => searchEvidence(s, { q: "termination decision", matterId: x.matter.id }));
    expect(hits[0]?.filename).toBe("DEF-000001.txt");

    const bomb = await upload(x.owner, x.matter.id, files.bomb!);
    await processor.drain();
    const b = await db.withFirm(x.owner, (s) => getEvidence(s, bomb.id));
    expect(b).toMatchObject({ extractionStatus: "partial", childCount: 1 });
  });

  it("search respects ethical walls, the privileged area and outside users", async () => {
    const x = await setup();
    await db.withFirm(x.owner, (s) => addMatterMember(s, { matterId: x.matter.id, userId: x.portal.id, access: "view", acknowledgePrivilegeWaiverRisk: true }));
    const red = (await db.withFirm(x.owner, (s) => listMatterFolders(s, x.matter.id))).find((f) => f.isPrivilegedArea)!;
    const priv = await upload(x.owner, x.matter.id, files.docx!, "strategy-memo.docx", red.id);
    const walledItem = await upload(x.owner, x.walled.id, files.pdf!, "walled-letter.pdf");
    const clientItem = await upload(x.portalCtx, x.matter.id, files.xlsx!, "my-damages.xlsx");
    await processor.drain();

    // The owner (member of both) finds everything.
    expect((await db.withFirm(x.owner, (s) => searchEvidence(s, { q: "125000" }))).map((h) => h.evidenceId)).toContain(priv.id);
    expect((await db.withFirm(x.owner, (s) => searchEvidence(s, { q: "FMLA" }))).map((h) => h.evidenceId)).toContain(walledItem.id);

    // Paralegal: not on the walled matter.
    const para = await db.withFirm(x.paraCtx, (s) => searchEvidence(s, { q: "FMLA" }));
    expect(para.map((h) => h.evidenceId)).not.toContain(walledItem.id);
    await db.withFirm(x.paraCtx, async (s) => {
      expect((await s.client.query("SELECT count(*)::int n FROM huis.evidence_text WHERE evidence_id = $1", [walledItem.id])).rows[0].n).toBe(0);
    });

    // Client: only their own upload; never privileged or firm text.
    const clientHits = await db.withFirm(x.portalCtx, (s) => searchEvidence(s, { q: "125000" }));
    expect(clientHits).toHaveLength(0);
    expect((await db.withFirm(x.portalCtx, (s) => searchEvidence(s, { q: "wages" }))).map((h) => h.evidenceId)).toEqual([clientItem.id]);
    await db.withFirm(x.portalCtx, async (s) => {
      expect((await s.client.query("SELECT count(*)::int n FROM huis.evidence_text")).rows[0].n).toBe(1);
    });
  });

  it("moving an email moves its attachments with it", async () => {
    const x = await setup();
    const email = await upload(x.owner, x.matter.id, files.eml!);
    await processor.drain();
    const red = (await db.withFirm(x.owner, (s) => listMatterFolders(s, x.matter.id))).find((f) => f.isPrivilegedArea)!;
    await db.withFirm(x.owner, (s) => moveEvidence(s, email.id, red.id));
    const all = await db.withFirm(x.owner, (s) => listEvidence(s, x.matter.id));
    for (const e of all) expect(e.folderIsPrivileged).toBe(true);
  });

  it("the app can't create derived items or write extracted text", async () => {
    const x = await setup();
    const item = await upload(x.owner, x.matter.id, files.pdf!);
    await expect(db.withFirm(x.owner, (s) => s.client.query(
      "INSERT INTO huis.evidence_text (evidence_id, firm_id, content, method, char_count) VALUES ($1, $2, 'forged', 'native', 6)",
      [item.id, x.firmId]))).rejects.toThrow();
    await expect(t.worker.query(
      "SELECT huis.worker_add_derived(1, gen_random_uuid(), gen_random_uuid(), 'x', 'x', null, 1, repeat('a', 64), 'k')"))
      .rejects.toThrow(/not held/);
  });
});

// ---------------------------------------------------------------------------
// Regression tests for the second independent security review (PR #4).
// ---------------------------------------------------------------------------
describe("security review 2 regressions", () => {
  it("F1: the app can't plant 'contained' items or fake extraction results", async () => {
    const x = await setup();
    const item = await upload(x.owner, x.matter.id, files.pdf!);
    const folder = (await db.withFirm(x.owner, (s) => listMatterFolders(s, x.matter.id))).find((f) => f.name === "Evidence")!;
    const base = "id, firm_id, matter_id, folder_id, original_filename, size_bytes, sha256, storage_key, source";
    const vals = `gen_random_uuid(), $1, $2, $3, 'x.txt', 1, repeat('a', 64), 'firm/x', 'upload'`;
    for (const [col, v] of [["parent_id", `'${item.id}'`], ["container_path", "'a/b'"], ["depth", "1"], ["extraction_status", "'done'"], ["root_id", `'${item.id}'`]]) {
      await expect(db.withFirm(x.owner, (s) => s.client.query(
        `INSERT INTO huis.evidence_items (${base}, ${col}) VALUES (${vals}, ${v})`, [x.firmId, x.matter.id, folder.id]))).rejects.toThrow();
    }
    await expect(db.withFirm(x.owner, (s) => s.client.query(
      `INSERT INTO huis.evidence_items (${base}) VALUES (gen_random_uuid(), $1, $2, $3, 'x.txt', 1, repeat('a', 64), 'firm/x', 'extracted')`,
      [x.firmId, x.matter.id, folder.id]))).rejects.toThrow();
  });

  it("F2: moving an email never pulls an attachment out of the privileged area", async () => {
    const x = await setup();
    const email = await upload(x.owner, x.matter.id, files.eml!);
    await processor.drain();
    const folders = await db.withFirm(x.owner, (s) => listMatterFolders(s, x.matter.id));
    const red = folders.find((f) => f.isPrivilegedArea)!;
    const corr = folders.find((f) => f.name === "Correspondence")!;
    const kids = await db.withFirm(x.owner, (s) => listContainedItems(s, email.id));
    const notes = kids.find((k) => k.originalFilename === "notes.txt")!;
    await db.withFirm(x.owner, (s) => moveEvidence(s, notes.id, red.id));
    await db.withFirm(x.owner, (s) => moveEvidence(s, email.id, corr.id));
    expect((await db.withFirm(x.owner, (s) => getEvidence(s, notes.id)))?.folderIsPrivileged).toBe(true);
    const letter = kids.find((k) => k.originalFilename === "letter.pdf")!;
    expect((await db.withFirm(x.owner, (s) => getEvidence(s, letter.id)))?.folderName).toBe("Correspondence");
  });

  it("F4: an archive can't unpack more than its size budget", async () => {
    const x = await setup();
    const item = await upload(x.owner, x.matter.id, files.zip!);
    // Run only the scan, then hold the extract job by hand.
    await processor.runOnce();
    const job = (await t.worker.query("SELECT * FROM huis.worker_claim_job()")).rows[0];
    expect(job.kind).toBe("evidence.extract");
    const add = (size: number) => {
      const id = newEvidenceId();
      return t.worker.query(
        "SELECT huis.worker_add_derived($1, $2, $3, 'big.bin', 'big.bin', null, $4, repeat('a', 64), $5)",
        [job.job_id, job.lock_token, id, size, `firm/${x.firmId}/matter/${x.matter.id}/evidence/${id}/original`]);
    };
    await add(1000);
    await expect(add(2 * 1024 ** 3)).rejects.toThrow(/quota/i);
    expect(item.id).toBeTruthy();
  });

  it("F5: reading extracted text and searching are recorded", async () => {
    const x = await setup();
    const item = await upload(x.owner, x.matter.id, files.pdf!);
    await processor.drain();
    await db.withFirm(x.owner, (s) => getEvidenceText(s, item.id));
    await db.withFirm(x.owner, (s) => searchEvidence(s, { q: "FMLA" }));
    const custody = (await t.admin.query("SELECT event, actor_user_id FROM huis.evidence_custody_events WHERE evidence_id = $1", [item.id])).rows;
    expect(custody).toContainEqual({ event: "viewed", actor_user_id: x.ownerUserId });
    const audit = (await t.admin.query("SELECT action, metadata FROM huis.audit_events WHERE firm_id = $1 AND action IN ('evidence.viewed','evidence.searched')", [x.firmId])).rows;
    expect(audit.map((a) => a.action).sort()).toEqual(["evidence.searched", "evidence.viewed"]);
    expect(audit.find((a) => a.action === "evidence.searched")!.metadata).toMatchObject({ query: "FMLA" });
  });

  it("F6: an email's searchable text doesn't reveal its attachments' names", async () => {
    const { result } = await run(files.eml!);
    expect(result.text).not.toMatch(/letter\.pdf|notes\.txt/);
    expect(result.children.map((c) => c.filename).sort()).toEqual(["letter.pdf", "notes.txt"]);
  });

  it("an infected file inside an archive quarantines the archive", async () => {
    const x = await setup();
    const zipPath = path.join(dir, "infected.zip");
    execFileSync("python3", ["-c", `
import zipfile, sys
with zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("ok.txt", "nothing to see")
    z.writestr("bad.txt", "EICAR-TEST " * 50)
`, zipPath]);
    const zip = await upload(x.owner, x.matter.id, zipPath);
    await processor.drain();
    expect((await db.withFirm(x.owner, (s) => getEvidence(s, zip.id)))?.status).toBe("infected");
    const events = (await t.admin.query("SELECT event FROM huis.evidence_custody_events WHERE evidence_id = $1", [zip.id])).rows.map((r) => r.event);
    expect(events).toContain("quarantined_contains_threat");
  });

  it("reads old-format PowerPoint (.ppt) files", async () => {
    const { result } = await run(path.join(__dirname, "fixtures/ppt/settlement.ppt"));
    expect(result.status).toBe("done");
    expect(result.text).toMatch(/Settlement offer slide/);
  });

  it("cleans up decrypted working folders left behind by a crash", async () => {
    const stale = await mkdtemp(path.join(os.tmpdir(), "huis-x-"));
    await writeFile(path.join(stale, "input"), "decrypted evidence");
    const old = new Date(Date.now() - 8 * 3600_000);
    const { utimes } = await import("node:fs/promises");
    await utimes(stale, old, old);
    expect(await EvidenceProcessor.sweepStaleWorkDirs()).toBeGreaterThanOrEqual(1);
    await expect(readFile(path.join(stale, "input"))).rejects.toThrow();
  });
});

describe("security review 2: move vs. unpacking race", () => {
  it("F3: an email moved to the privileged area while it is being unpacked takes all its attachments with it", async () => {
    const x = await setup();
    const shared = (await db.withFirm(x.owner, (s) => listMatterFolders(s, x.matter.id))).find((f) => f.name === "Client Uploads")!;
    const red = (await db.withFirm(x.owner, (s) => listMatterFolders(s, x.matter.id))).find((f) => f.isPrivilegedArea)!;
    const email = await upload(x.owner, x.matter.id, files.eml!, "mail.eml", shared.id);

    // Start the move at the worst moment: attachments recorded, transaction not yet committed.
    let move: Promise<unknown> | null = null;
    const racingPool = {
      query: t.worker.query.bind(t.worker),
      connect: async () => {
        const c = await t.worker.connect();
        const original = c.query;
        const q = original.bind(c) as (...a: unknown[]) => Promise<unknown>;
        (c as unknown as { query: unknown }).query = async (...args: unknown[]) => {
          if (!move && typeof args[0] === "string" && args[0].includes("worker_save_extraction")) {
            move = db.withFirm(x.owner, (s) => moveEvidence(s, email.id, red.id));
            await new Promise((r) => setTimeout(r, 300)); // the move is now waiting on the unpacking lock
          }
          return q(...args);
        };
        const release = c.release.bind(c);
        c.release = (err?: Error | boolean) => { c.query = original; return release(err); };
        return c;
      },
    } as unknown as pg.Pool;
    await new EvidenceProcessor(racingPool, vault, scanner).drain();
    expect(move).not.toBeNull();
    await move;

    const kids = await db.withFirm(x.owner, (s) => listContainedItems(s, email.id));
    expect(kids.length).toBe(2);
    for (const k of kids) expect(k.folderIsPrivileged).toBe(true);
    expect(await db.withFirm(x.portalCtx, (s) => searchEvidence(s, { q: "PTO" }))).toHaveLength(0);
  });
});
