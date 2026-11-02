import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import readline from "node:readline";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import yauzl from "yauzl";
import { cleanText, decodeText, htmlToText, readHead, run, safeName } from "./tools";
import { LIMITS, type ContainedFile, type EmailHeaders, type ExtractInput, type ExtractResult } from "./types";

const empty = (over: Partial<ExtractResult>): ExtractResult => ({
  status: "done", detail: "", text: "", method: "native", pages: null, email: null, children: [], ...over,
});

const ext = (name: string) => path.extname(name).toLowerCase().replace(/^\./, "");

// ---------------------------------------------------------------------------
// PDF: real text first; scanned pages are OCR'd.
// ---------------------------------------------------------------------------
/** Makes sure a display name ends with the given extension (when one is required). */
function withExt(name: string, required: string | null): string {
  if (!required || name.toLowerCase().endsWith(`.${required}`)) return name;
  return `${name.slice(0, 250)}.${required}`;
}

export async function extractPdf(input: ExtractInput): Promise<ExtractResult> {
  let pages: number | null = null;
  try {
    const info = await run("pdfinfo", [input.inputPath], { timeoutSec: 60 });
    const m = /^Pages:\s+(\d+)/m.exec(info);
    pages = m ? Number(m[1]) : null;
  } catch {
    return empty({ status: "unsupported", detail: "This PDF could not be opened (damaged or password-protected)." });
  }
  let text = "";
  try {
    const out = path.join(input.outDir, "pdftext.txt");
    await run("pdftotext", ["-layout", "-enc", "UTF-8", input.inputPath, out], { timeoutSec: 900 });
    text = (await readHead(out, LIMITS.maxTextChars * 2)).toString("utf8");
  } catch {
    text = "";
  }
  const perPage = pages ? text.replace(/\s+/g, "").length / pages : 0;
  if (pages && perPage < 40) {
    // Little or no real text: treat as scanned and read it with OCR.
    const ocr = await ocrPdf(input, pages);
    if (ocr.text.trim()) {
      const method = text.trim() ? "mixed" : "ocr";
      return empty({
        status: ocr.complete ? "done" : "partial",
        detail: ocr.complete ? `Scanned document read with OCR (${pages} pages).`
          : `Only part of this ${pages}-page scan was read with OCR (size or time limit).`,
        text: cleanText(`${text}\n${ocr.text}`), method, pages,
      });
    }
  }
  const cleaned = cleanText(text);
  return empty({
    status: cleaned.trim() ? "done" : "no_text",
    detail: cleaned.trim() ? `Text extracted from ${pages ?? "?"} pages.` : "No readable text found.",
    text: cleaned, pages,
  });
}

async function ocrPdf(input: ExtractInput, pages: number): Promise<{ text: string; complete: boolean }> {
  const last = Math.min(pages, LIMITS.maxOcrPages);
  const parts: string[] = [];
  const prefix = path.join(input.outDir, "ocrpage");
  // Stop in time to save what was read, well before the sandbox time limit.
  const deadline = Date.now() + LIMITS.ocrBudgetSec * 1000;
  for (let p = 1; p <= last; p++) {
    if (Date.now() > deadline) {
      parts.push(`\n--- Pages ${p}–${pages} not yet read (time limit) ---\n`);
      return { text: parts.join(""), complete: false };
    }
    try {
      await run("pdftoppm", ["-r", "200", "-gray", "-png", "-f", String(p), "-l", String(p), "-singlefile", input.inputPath, prefix], { timeoutSec: 120 });
      parts.push(`\n--- Page ${p} ---\n` + (await run("tesseract", [`${prefix}.png`, "-", "-l", "eng"], { timeoutSec: 180 })));
    } catch {
      parts.push(`\n--- Page ${p} (could not be read) ---\n`);
    }
  }
  return { text: parts.join(""), complete: last === pages };
}

// ---------------------------------------------------------------------------
// Images: OCR
// ---------------------------------------------------------------------------
export async function extractImage(input: ExtractInput): Promise<ExtractResult> {
  try {
    const text = cleanText(await run("tesseract", [input.inputPath, "-", "-l", "eng"], { timeoutSec: 180 }));
    return empty({
      status: text.trim() ? "done" : "no_text",
      detail: text.trim() ? "Image read with OCR." : "No readable text in this image.",
      text, method: "ocr",
    });
  } catch {
    return empty({ status: "unsupported", detail: "This image format can't be read yet." });
  }
}

// ---------------------------------------------------------------------------
// Office documents
// ---------------------------------------------------------------------------
export async function extractDocx(input: ExtractInput): Promise<ExtractResult> {
  const mammoth = await import("mammoth");
  const res = await mammoth.extractRawText({ path: input.inputPath });
  const text = cleanText(res.value);
  return empty({ status: text.trim() ? "done" : "no_text", detail: "Word document text extracted.", text });
}

/** Reads text from Office Open XML parts (Excel shared strings + sheets, PowerPoint slides). */
export async function extractOoxml(input: ExtractInput, kind: "xlsx" | "pptx"): Promise<ExtractResult> {
  const parts = await readZipTextParts(input.inputPath, (name) =>
    kind === "xlsx" ? /^xl\/(sharedStrings\.xml|worksheets\/sheet\d+\.xml)$/.test(name) : /^ppt\/slides\/slide\d+\.xml$/.test(name));
  const order = Object.keys(parts).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const lines: string[] = [];
  if (kind === "xlsx") {
    const shared = [...(parts["xl/sharedStrings.xml"] ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)]
      .map((m) => [...m[1]!.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(""));
    for (const name of order.filter((n) => n.startsWith("xl/worksheets/"))) {
      lines.push(`--- ${path.basename(name, ".xml")} ---`);
      for (const row of parts[name]!.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
        const cells = [...row[1]!.matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)].map(([, attrs, body]) => {
          const v = /<v>([\s\S]*?)<\/v>/.exec(body!)?.[1] ?? /<t[^>]*>([\s\S]*?)<\/t>/.exec(body!)?.[1] ?? "";
          return /t="s"/.test(attrs!) ? shared[Number(v)] ?? "" : v;
        });
        if (cells.some((c) => c !== "")) lines.push(cells.join("\t"));
      }
    }
  } else {
    for (const name of order) {
      lines.push(`--- ${path.basename(name, ".xml")} ---`);
      lines.push([...parts[name]!.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => m[1]).join(" "));
    }
  }
  const text = cleanText(htmlToText(lines.join("\n")));
  return empty({ status: text.trim() ? "done" : "no_text", detail: kind === "xlsx" ? "Spreadsheet text extracted." : "Slide text extracted.", text });
}

async function readZipTextParts(file: string, want: (name: string) => boolean): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  let total = 0;
  await forEachZipEntry(file, async (entry, open) => {
    if (!want(entry.fileName) || entry.uncompressedSize > 200 * 1024 * 1024) return;
    total += entry.uncompressedSize;
    if (total > 500 * 1024 * 1024) throw new Error("document too large");
    const chunks: Buffer[] = [];
    for await (const c of await open()) chunks.push(c as Buffer);
    out[entry.fileName] = Buffer.concat(chunks).toString("utf8");
  });
  return out;
}

/** Older Office formats (.doc, .xls, .ppt) and RTF via LibreOffice, isolated. */
export async function extractWithLibreOffice(input: ExtractInput, target: "txt:Text" | "csv"): Promise<ExtractResult> {
  const profile = path.join(input.outDir, "lo-profile");
  try {
    await run("soffice", [
      `-env:UserInstallation=file://${profile}`, "--headless", "--norestore", "--nolockcheck",
      "--convert-to", target, "--outdir", input.outDir, input.inputPath,
    ], { timeoutSec: 180 });
  } catch {
    return empty({ status: "unsupported", detail: "This document could not be converted to text." });
  }
  const want = target === "csv" ? ".csv" : ".txt";
  const produced = (await readdir(input.outDir)).find((f) => f.endsWith(want));
  if (!produced) return empty({ status: "unsupported", detail: "This document could not be converted to text." });
  const text = cleanText(decodeText(await readFile(path.join(input.outDir, produced))));
  return empty({ status: text.trim() ? "done" : "no_text", detail: "Document text extracted.", text });
}

/** Presentations: convert to PDF with LibreOffice, then read the PDF. */
export async function extractViaPdf(input: ExtractInput): Promise<ExtractResult> {
  const profile = path.join(input.outDir, "lo-profile");
  try {
    await run("soffice", [`-env:UserInstallation=file://${profile}`, "--headless", "--norestore", "--nolockcheck",
      "--convert-to", "pdf", "--outdir", input.outDir, input.inputPath], { timeoutSec: 300 });
  } catch {
    return empty({ status: "unsupported", detail: "This presentation could not be converted." });
  }
  const pdf = (await readdir(input.outDir)).find((f) => f.endsWith(".pdf"));
  if (!pdf) return empty({ status: "unsupported", detail: "This presentation could not be converted." });
  return extractPdf({ ...input, inputPath: path.join(input.outDir, pdf) });
}

// ---------------------------------------------------------------------------
// Plain text, HTML, CSV
// ---------------------------------------------------------------------------
export async function extractPlain(input: ExtractInput, html: boolean): Promise<ExtractResult> {
  let text = decodeText(await readHead(input.inputPath, 50 * 1024 * 1024));
  if (html) text = htmlToText(text);
  text = cleanText(text);
  return empty({ status: text.trim() ? "done" : "no_text", detail: "Text extracted.", text });
}

// ---------------------------------------------------------------------------
// Email: .eml (and messages split from .mbox), .msg
// ---------------------------------------------------------------------------
type AddrLike = { value?: { address?: string; name?: string }[] } | { value?: { address?: string; name?: string }[] }[] | undefined;
function addrs(a: AddrLike): string[] {
  const list = Array.isArray(a) ? a.flatMap((x) => x.value ?? []) : a?.value ?? [];
  return list.map((v) => (v.name && v.address ? `${v.name} <${v.address}>` : v.address ?? v.name ?? "")).filter(Boolean).slice(0, 500);
}

/**
 * The searchable text of an email. Attachment names are deliberately left
 * out: each attachment is its own item with its own visibility, so its name
 * must not be findable through the email (e.g. if it's moved to the red area).
 */
function emailText(h: EmailHeaders, body: string): string {
  return cleanText([
    `From: ${h.from ?? ""}`,
    `To: ${h.to.join(", ")}`,
    ...(h.cc.length ? [`Cc: ${h.cc.join(", ")}`] : []),
    ...(h.bcc.length ? [`Bcc: ${h.bcc.join(", ")}`] : []),
    `Date: ${h.date ?? ""}`,
    `Subject: ${h.subject ?? ""}`,
    "",
    body,
  ].join("\n"));
}

export async function extractEml(input: ExtractInput): Promise<ExtractResult> {
  const { simpleParser } = await import("mailparser");
  const size = (await stat(input.inputPath)).size;
  if (size > 1024 ** 3) return empty({ status: "unsupported", detail: "Email file is too large to open." });
  const mail = await simpleParser(await readFile(input.inputPath), { skipHtmlToText: false, skipTextToHtml: true, skipImageLinks: true });
  const headers: EmailHeaders = {
    from: addrs(mail.from as AddrLike)[0] ?? null,
    to: addrs(mail.to as AddrLike), cc: addrs(mail.cc as AddrLike), bcc: addrs(mail.bcc as AddrLike),
    subject: mail.subject ?? null,
    date: mail.date && !Number.isNaN(mail.date.getTime()) ? mail.date.toISOString() : null,
    messageId: mail.messageId ?? null,
    inReplyTo: typeof mail.inReplyTo === "string" ? mail.inReplyTo : null,
  };
  const children: ContainedFile[] = [];
  let i = 0;
  for (const att of mail.attachments.slice(0, LIMITS.maxChildren)) {
    i += 1;
    const embedded = /^message\/rfc822$/i.test(att.contentType ?? "");
    const filename = withExt(safeName(att.filename, embedded ? `attached-message-${i}` : `attachment-${i}`), embedded ? "eml" : null);
    const out = path.join(input.outDir, `att-${i}`);
    await writeFile(out, att.content, { mode: 0o600 });
    children.push({
      path: out, filename,
      containerPath: embedded ? `Attached message ${i}` : `Attachment ${i}: ${filename}`,
      declaredType: att.contentType ?? null,
    });
  }
  const body = mail.text ?? (typeof mail.html === "string" ? htmlToText(mail.html) : "");
  return empty({
    detail: children.length ? `Email with ${children.length} attachment(s); each attachment is a separate item.` : "Email read.",
    text: emailText(headers, body), email: headers, children,
  });
}

export async function extractMsg(input: ExtractInput): Promise<ExtractResult> {
  const { default: MsgReader } = await import("@kenjiuno/msgreader");
  const size = (await stat(input.inputPath)).size;
  if (size > 1024 ** 3) return empty({ status: "unsupported", detail: "Email file is too large to open." });
  const reader = new MsgReader((await readFile(input.inputPath)) as unknown as ArrayBuffer);
  const info = reader.getFileData() as {
    senderName?: string; senderEmail?: string; senderSmtpAddress?: string; subject?: string; body?: string; bodyHtml?: string;
    messageDeliveryTime?: string; clientSubmitTime?: string; internetMessageId?: string; inReplyToId?: string;
    recipients?: { name?: string; email?: string; smtpAddress?: string; recipType?: string }[];
    attachments?: { fileName?: string; fileNameShort?: string; name?: string; attachMimeTag?: string; innerMsgContent?: boolean }[];
    error?: string;
  };
  if (info.error) return empty({ status: "unsupported", detail: "This Outlook message could not be opened." });
  const fmt = (n?: string, e?: string) => (n && e && n !== e ? `${n} <${e}>` : e ?? n ?? "");
  const recips = (type: string) => (info.recipients ?? []).filter((r) => (r.recipType ?? "to") === type)
    .map((r) => fmt(r.name, r.smtpAddress ?? r.email)).filter(Boolean);
  const when = info.messageDeliveryTime ?? info.clientSubmitTime;
  const parsed = when ? new Date(when) : null;
  const headers: EmailHeaders = {
    from: fmt(info.senderName, info.senderSmtpAddress ?? info.senderEmail) || null,
    to: recips("to"), cc: recips("cc"), bcc: recips("bcc"),
    subject: info.subject ?? null,
    date: parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : null,
    messageId: info.internetMessageId ?? null,
    inReplyTo: info.inReplyToId ?? null,
  };
  const children: ContainedFile[] = [];
  let unreadable = 0;
  const attachments = (info.attachments ?? []).slice(0, LIMITS.maxChildren);
  for (let idx = 0; idx < attachments.length; idx++) {
    const att = attachments[idx]!;
    let got: { fileName?: string; content?: Uint8Array } | null = null;
    try {
      got = reader.getAttachment(att as never) as { fileName?: string; content?: Uint8Array };
    } catch {
      got = null;
    }
    if (!got?.content) { unreadable += 1; continue; }
    const embedded = att.innerMsgContent === true;
    // Embedded Outlook messages are rebuilt as standalone .msg files so they
    // are read (and their own attachments split out) like any other message.
    const filename = withExt(safeName(got.fileName ?? att.fileName ?? att.name, embedded ? `attached-message-${idx + 1}` : `attachment-${idx + 1}`), embedded ? "msg" : null);
    const out = path.join(input.outDir, `att-${idx + 1}`);
    await writeFile(out, got.content, { mode: 0o600 });
    children.push({
      path: out, filename,
      containerPath: embedded ? `Attached message ${idx + 1}` : `Attachment ${idx + 1}: ${filename}`,
      declaredType: embedded ? "application/vnd.ms-outlook" : att.attachMimeTag ?? null,
    });
  }
  const body = info.body ?? (info.bodyHtml ? htmlToText(info.bodyHtml) : "");
  return empty({
    status: unreadable ? "partial" : "done",
    detail: [
      children.length ? `Outlook message with ${children.length} attachment(s); each attachment is a separate item.` : "Outlook message read.",
      unreadable ? `${unreadable} attachment(s) could not be read.` : "",
    ].filter(Boolean).join(" "),
    text: emailText(headers, body), email: headers, children,
  });
}

/** Splits an .mbox mailbox export into one .eml item per message, reading it as a stream. */
export async function extractMbox(input: ExtractInput): Promise<ExtractResult> {
  const children: ContainedFile[] = [];
  const rl = readline.createInterface({ input: createReadStream(input.inputPath, { encoding: "latin1" }), crlfDelay: Infinity });
  let current: ReturnType<typeof createWriteStream> | null = null;
  let previousBlank = true;
  let truncated = false;
  const close = () => new Promise<void>((res) => (current ? current.end(res) : res()));
  for await (const line of rl) {
    if (line.startsWith("From ") && previousBlank) {
      await close();
      current = null;
      if (children.length >= LIMITS.maxChildren) { truncated = true; break; }
      const n = children.length + 1;
      const out = path.join(input.outDir, `msg-${n}.eml`);
      current = createWriteStream(out, { mode: 0o600, encoding: "latin1" });
      children.push({ path: out, filename: `message-${String(n).padStart(5, "0")}.eml`, containerPath: `Message ${n}`, declaredType: "message/rfc822" });
    } else if (current) {
      if (!current.write(`${line.startsWith(">From ") ? line.slice(1) : line}\r\n`)) await new Promise((r) => current!.once("drain", r));
    }
    previousBlank = line.trim() === "";
  }
  await close();
  rl.close();
  return empty({
    status: children.length ? (truncated ? "partial" : "done") : "no_text",
    detail: children.length ? `Mailbox split into ${children.length} message(s); each is a separate item.` : "No messages found in this mailbox.",
    children,
  });
}

// ---------------------------------------------------------------------------
// Outlook data files (.pst / .ost): every email, calendar entry and contact
// ---------------------------------------------------------------------------
/** Outlook mailboxes can hold far more items than an archive. */
export const PST_MAX_ITEMS = 200_000;

/**
 * Splits an Outlook data file into one item per message (.eml), calendar
 * entry (.ics) and contact (.vcf), recording the mailbox folder each came
 * from ("Inbox/Smith matter"). readpst writes into a scratch folder using
 * folder names taken from the mailbox; those names are only ever used as
 * labels — every file is moved to a generated name, and anything that isn't
 * a plain file (links, devices) is ignored.
 */
export async function extractPst(input: ExtractInput): Promise<ExtractResult> {
  const scratch = path.join(input.outDir, "pst-raw");
  await mkdir(scratch, { mode: 0o700 });
  try {
    try {
      // -e one file per item, -b skip duplicate RTF bodies, -q quiet, -j 0 single-threaded.
      await run("readpst", ["-e", "-b", "-q", "-j", "0", "-o", scratch, input.inputPath], { timeoutSec: 3 * 3600, maxBytes: 1024 * 1024 });
    } catch {
      // A damaged mailbox may still have produced items; keep what was read.
    }
    const children: ContainedFile[] = [];
    let truncated = false;
    const walk = async (dir: string, rel: string[]): Promise<void> => {
      const names = (await readdir(dir)).sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
      for (const name of names) {
        if (truncated) return;
        const full = path.join(dir, name);
        const st = await lstat(full);
        if (st.isDirectory()) { if (rel.length < 64) await walk(full, [...rel, name]); continue; }
        if (!st.isFile()) continue;
        if (children.length >= PST_MAX_ITEMS) { truncated = true; return; }
        const n = children.length + 1;
        const kind = path.extname(name).toLowerCase();
        const target = path.join(input.outDir, `pst-${n}${kind === ".eml" || kind === ".ics" || kind === ".vcf" ? kind : ""}`);
        await rename(full, target);
        // The top folder is the mailbox's own name; show the path inside it.
        const folder = rel.slice(1).join("/") || rel[0] || "";
        const label = kind === ".ics" ? "calendar-entry" : kind === ".vcf" ? "contact" : "message";
        children.push({
          path: target,
          filename: `${label}-${String(n).padStart(6, "0")}${kind === ".ics" || kind === ".vcf" || kind === ".eml" ? kind : ""}`,
          containerPath: `${folder.slice(0, 2000)}${folder ? "/" : ""}${name.slice(0, 255)}`,
          declaredType: kind === ".eml" ? "message/rfc822" : kind === ".ics" ? "text/calendar" : kind === ".vcf" ? "text/vcard" : null,
        });
      }
    };
    await walk(scratch, []);
    return empty({
      status: children.length ? (truncated ? "partial" : "done") : "no_text",
      detail: children.length
        ? `Outlook mailbox split into ${children.length} item(s) (emails, calendar entries, contacts); each is a separate item.${truncated ? ` Stopped at ${PST_MAX_ITEMS.toLocaleString("en-US")} items.` : ""}`
        : "No items could be read from this Outlook data file (it may be damaged).",
      children,
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// ZIP archives (discovery productions, drive exports)
// ---------------------------------------------------------------------------
interface ZipEntry { fileName: string; uncompressedSize: number; compressedSize: number; }

/**
 * Walks a ZIP's entries. Entry names are only ever used as labels — files are
 * written under generated names — so unusual names (including "../" tricks)
 * are recorded as-is for the record rather than rejected.
 */
function forEachZipEntry(file: string, fn: (e: ZipEntry, open: () => Promise<NodeJS.ReadableStream>) => Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: true, decodeStrings: false, validateEntrySizes: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error("zip open failed"));
      zip.on("error", reject);
      zip.on("end", () => resolve());
      zip.on("entry", (entry: yauzl.Entry) => {
        const raw = entry.fileName as unknown as Buffer;
        const utf8 = (entry.generalPurposeBitFlag & 0x800) !== 0;
        const fileName = (utf8 ? raw.toString("utf8") : raw.toString("latin1")).replace(/\\/g, "/").replace(/[\u0000-\u001f]/g, "");
        const open = () => new Promise<NodeJS.ReadableStream>((res, rej) =>
          zip.openReadStream(entry, (e, s) => (e || !s ? rej(e ?? new Error("entry")) : res(s))));
        fn({ fileName, uncompressedSize: entry.uncompressedSize, compressedSize: entry.compressedSize }, open)
          .then(() => zip.readEntry(), (e) => { zip.close(); reject(e); });
      });
      zip.readEntry();
    });
  });
}

export async function extractZip(input: ExtractInput): Promise<ExtractResult> {
  const children: ContainedFile[] = [];
  const skipped: string[] = [];
  let entries = 0;
  let unpacked = 0;
  let n = 0;
  try {
    await forEachZipEntry(input.inputPath, async (entry, open) => {
      if (entry.fileName.endsWith("/")) return;
      entries += 1;
      if (children.length >= LIMITS.maxChildren) { skipped.push(`${entry.fileName} (too many files)`); return; }
      const ratio = entry.compressedSize > 0 ? entry.uncompressedSize / entry.compressedSize : Infinity;
      if (entry.uncompressedSize > LIMITS.maxChildBytes
          || (entry.uncompressedSize > 1024 * 1024 && ratio > LIMITS.maxCompressionRatio)
          || unpacked + entry.uncompressedSize > LIMITS.maxUnpackedBytes) {
        skipped.push(`${entry.fileName} (unsafe size)`);
        return;
      }
      n += 1;
      const out = path.join(input.outDir, `entry-${n}`);
      let written = 0;
      const limit = new Transform({
        transform(chunk: Buffer, _e, cb) {
          written += chunk.length;
          if (written > entry.uncompressedSize || written > LIMITS.maxChildBytes) cb(new Error("entry larger than declared"));
          else cb(null, chunk);
        },
      });
      await pipeline(await open(), limit, createWriteStream(out, { mode: 0o600 }));
      unpacked += written;
      children.push({
        path: out, filename: safeName(entry.fileName, `file-${n}`),
        containerPath: entry.fileName.slice(0, 4096), declaredType: null,
      });
    });
  } catch {
    return empty({
      status: children.length ? "partial" : "unsupported",
      detail: children.length ? `Archive partly unpacked (${children.length} of ${entries} files); the rest is damaged.` : "This archive could not be opened (damaged or encrypted).",
      children,
    });
  }
  return empty({
    status: skipped.length ? "partial" : "done",
    detail: `Archive unpacked: ${children.length} file(s), each a separate item.${skipped.length ? ` ${skipped.length} skipped for safety.` : ""}`,
    // Contents are searchable through their own items (each with its own
    // visibility), so the archive's own text lists only what was skipped.
    text: skipped.length ? cleanText(["Not unpacked (safety limits):", ...skipped].join("\n")) : "",
    children,
  });
}

// ---------------------------------------------------------------------------
// Audio and video: transcription through an approved, zero-retention provider
// ---------------------------------------------------------------------------
export interface TranscriptionProvider {
  readonly name: string;
  transcribe(file: string): Promise<{ text: string; speakers: boolean }>;
}

export async function extractMedia(input: ExtractInput, provider: TranscriptionProvider | null): Promise<ExtractResult> {
  let duration: number | null = null;
  try {
    const out = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nk=1:nw=1", input.inputPath], { timeoutSec: 60 });
    duration = Number.parseFloat(out) || null;
  } catch {
    // unreadable media is reported below
  }
  if (!provider) {
    return empty({
      status: "needs_provider",
      detail: `Audio/video${duration ? ` (${Math.round(duration / 60)} min)` : ""} — transcription starts once an approved, zero-retention transcription provider is connected.`,
    });
  }
  const audio = path.join(input.outDir, "audio.wav");
  await run("ffmpeg", ["-nostdin", "-v", "error", "-i", input.inputPath, "-vn", "-ac", "1", "-ar", "16000", "-f", "wav", audio], { timeoutSec: 1800 });
  const t = await provider.transcribe(audio);
  const text = cleanText(t.text);
  return empty({
    status: text.trim() ? "done" : "no_text",
    detail: `Transcribed by ${provider.name}${t.speakers ? " with speaker labels" : ""}.`,
    text, method: "transcript",
  });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
export async function extract(input: ExtractInput, provider: TranscriptionProvider | null = null): Promise<ExtractResult> {
  const type = input.detectedType ?? "";
  const e = ext(input.filename);
  if (input.depth >= LIMITS.maxDepth && (/ZIP|Email|Outlook/.test(type) || e === "msg" || e === "mbox")) {
    return empty({ status: "unsupported", detail: "Nested too deeply to unpack further." });
  }
  if (type.includes("program") || /executable/i.test(type)) {
    return empty({ status: "unsupported", detail: "Programs are not opened or unpacked." });
  }
  if (type === "PDF") return extractPdf(input);
  if (/image/i.test(type)) {
    if (type === "HEIC photo") return empty({ status: "unsupported", detail: "HEIC photos can't be read for text yet." });
    return extractImage(input);
  }
  if (type === "Word document") return extractDocx(input);
  if (type === "Excel workbook") return extractOoxml(input, "xlsx");
  if (type === "PowerPoint") return extractOoxml(input, "pptx");
  if (type.startsWith("ZIP")) {
    if (e === "docx") return extractDocx(input);
    if (e === "xlsx") return extractOoxml(input, "xlsx");
    if (e === "pptx") return extractOoxml(input, "pptx");
    return extractZip(input);
  }
  if (type.startsWith("Legacy Office")) {
    if (e === "msg") return extractMsg(input);
    if (e === "xls") return extractWithLibreOffice(input, "csv");
    if (e === "ppt" || e === "pps") return extractViaPdf(input);
    return extractWithLibreOffice(input, "txt:Text");
  }
  if (type === "Rich text") return extractWithLibreOffice(input, "txt:Text");
  if (e === "mbox") return extractMbox(input);
  if (type === "Email (.eml)" || e === "eml") return extractEml(input);
  if (type.includes(".pst")) return extractPst(input);
  if (e === "ics" || e === "vcf") return extractPlain(input, false);
  if (/audio|video/i.test(type)) return extractMedia(input, provider);
  if (type === "Web page (HTML)") return extractPlain(input, true);
  if (type === "Text") return extractPlain(input, e === "html" || e === "htm");
  if (type === "Empty file") return empty({ status: "no_text", detail: "Empty file." });
  return empty({ status: "unsupported", detail: "Text can't be extracted from this file type yet." });
}
