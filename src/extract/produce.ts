/**
 * Produces redacted and/or exhibit-stamped, Bates-numbered copies.
 *
 * Runs inside the extraction sandbox (the source is untrusted). Every page is
 * rendered to an image and redaction boxes are painted black INTO THE PIXELS,
 * then a brand-new PDF is written containing only those images plus any
 * stamp text. Nothing from the original file — its text layer, hidden text,
 * metadata, attachments, scripts or form fields — is carried over, so
 * nothing under a redaction can be recovered.
 */
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { pdfPageCount, run } from "./tools";

export interface RedactionBox { page: number; x: number; y: number; w: number; h: number }

export interface ProduceInput {
  mode: "produce";
  inputPath: string;
  outPath: string;
  workDir: string;
  pageCount: number;
  redactions: RedactionBox[];
  exhibitLabel: string | null;
  batesPrefix: string | null;
  batesStart: number | null;
}

export interface ProduceResult { pages: number; path: string }

/** Rendering resolution: legible for court filings, reasonable file size. */
export const PRODUCE_DPI = 150;
const MAX_PIXELS = 60_000_000; // per page (e.g. 7,700 × 7,700) — refuse absurd page sizes

/** Parses a binary PPM (P6) image. */
export function parsePpm(buf: Buffer): { width: number; height: number; pixels: Buffer } {
  let pos = 0;
  const token = (): string => {
    for (;;) {
      while (pos < buf.length && /\s/.test(String.fromCharCode(buf[pos]!))) pos += 1;
      if (buf[pos] === 0x23) { while (pos < buf.length && buf[pos] !== 0x0a) pos += 1; continue; }
      break;
    }
    const start = pos;
    while (pos < buf.length && !/\s/.test(String.fromCharCode(buf[pos]!))) pos += 1;
    return buf.subarray(start, pos).toString("ascii");
  };
  if (token() !== "P6") throw new Error("not a PPM image");
  const width = Number(token());
  const height = Number(token());
  const max = Number(token());
  pos += 1; // single whitespace before pixel data
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || max !== 255) throw new Error("bad PPM");
  if (width * height > MAX_PIXELS) throw new Error("page too large");
  const pixels = buf.subarray(pos, pos + width * height * 3);
  if (pixels.length !== width * height * 3) throw new Error("truncated PPM");
  return { width, height, pixels };
}

/**
 * Paints boxes solid black into RGB pixels. Boxes are fractions of the page
 * as displayed; edges are rounded outward so nothing at a border survives.
 */
export function paintRedactions(img: { width: number; height: number; pixels: Buffer }, boxes: RedactionBox[]): void {
  for (const b of boxes) {
    const x0 = Math.max(0, Math.floor(b.x * img.width) - 1);
    const y0 = Math.max(0, Math.floor(b.y * img.height) - 1);
    const x1 = Math.min(img.width, Math.ceil((b.x + b.w) * img.width) + 1);
    const y1 = Math.min(img.height, Math.ceil((b.y + b.h) * img.height) + 1);
    for (let y = y0; y < y1; y++) img.pixels.fill(0, (y * img.width + x0) * 3, (y * img.width + x1) * 3);
  }
}

/** Only plain characters ever reach the PDF (no escapes needed, nothing to inject). */
function stampText(s: string): string {
  return s.replace(/[^A-Za-z0-9 .#_-]/g, "").slice(0, 60);
}

export function batesNumber(prefix: string, n: number): string {
  return `${stampText(prefix)}-${String(n).padStart(6, "0")}`;
}

/** Minimal, append-only PDF writer for image pages with a little stamp text. */
class PdfWriter {
  private offsets: number[] = [];
  private pos = 0;
  private readonly out;
  private pageIds: number[] = [];
  private nextId = 4; // 1 catalog, 2 pages, 3 font

  constructor(file: string) {
    this.out = createWriteStream(file, { mode: 0o600 });
  }

  private async write(chunk: Buffer | string): Promise<void> {
    const b = typeof chunk === "string" ? Buffer.from(chunk, "latin1") : chunk;
    this.pos += b.length;
    if (!this.out.write(b)) await new Promise<void>((r) => this.out.once("drain", () => r()));
  }

  private async object(id: number, body: Buffer | string, stream?: Buffer): Promise<void> {
    this.offsets[id] = this.pos;
    await this.write(`${id} 0 obj\n`);
    await this.write(body);
    if (stream) {
      await this.write("\nstream\n");
      await this.write(stream);
      await this.write("\nendstream");
    }
    await this.write("\nendobj\n");
  }

  async begin(): Promise<void> {
    await this.write("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n");
    await this.object(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  }

  async page(img: { width: number; height: number; pixels: Buffer }, stamps: { text: string; corner: "bottom-right"; line: number }[]): Promise<void> {
    const wPt = (img.width * 72) / PRODUCE_DPI;
    const hPt = (img.height * 72) / PRODUCE_DPI;
    const imageId = this.nextId++;
    const contentId = this.nextId++;
    const pageId = this.nextId++;
    const data = deflateSync(img.pixels, { level: 6 });
    await this.object(imageId,
      `<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${data.length} >>`,
      data);
    let ops = `q ${wPt.toFixed(2)} 0 0 ${hPt.toFixed(2)} 0 0 cm /Im0 Do Q\n`;
    for (const s of stamps) {
      const text = stampText(s.text);
      if (!text) continue;
      const size = 10;
      const width = text.length * size * 0.62 + 12;
      const height = size + 8;
      const x = wPt - width - 18;
      const y = 14 + s.line * (height + 4);
      ops += `q 1 1 1 rg 0 0 0 RG 0.8 w ${x.toFixed(2)} ${y.toFixed(2)} ${width.toFixed(2)} ${height} re B Q\n`;
      ops += `BT 0 0 0 rg /F1 ${size} Tf ${(x + 6).toFixed(2)} ${(y + 5).toFixed(2)} Td (${text}) Tj ET\n`;
    }
    const content = Buffer.from(ops, "latin1");
    await this.object(contentId, `<< /Length ${content.length} >>`, content);
    await this.object(pageId,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${wPt.toFixed(2)} ${hPt.toFixed(2)}] /Resources << /XObject << /Im0 ${imageId} 0 R >> /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`);
    this.pageIds.push(pageId);
  }

  async finish(): Promise<void> {
    await this.object(2, `<< /Type /Pages /Kids [${this.pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${this.pageIds.length} >>`);
    await this.object(1, "<< /Type /Catalog /Pages 2 0 R >>");
    const xref = this.pos;
    const count = this.nextId;
    let table = `xref\n0 ${count}\n0000000000 65535 f \n`;
    for (let i = 1; i < count; i++) table += `${String(this.offsets[i] ?? 0).padStart(10, "0")} 00000 n \n`;
    await this.write(table);
    await this.write(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    await new Promise<void>((resolve, reject) => { this.out.end(() => resolve()); this.out.once("error", reject); });
  }
}

export async function produceCopy(input: ProduceInput): Promise<ProduceResult> {
  // The page count was fixed when the copy was requested (Bates numbers are
  // reserved for it). It must match the PDF's real page tree, and the
  // renderer must agree there is no page after the last one, or pages could
  // be silently left out of a production.
  const pages = await pdfPageCount(input.inputPath);
  if (pages !== input.pageCount) throw new Error("page count does not match");
  const beyond = await run("pdftoppm", ["-r", "10", "-f", String(pages + 1), "-l", String(pages + 1), "-cropbox", input.inputPath, path.join(input.workDir, "probe")],
    { timeoutSec: 60 }).then(() => true, () => false);
  if (beyond) throw new Error("renderer sees more pages than the page tree");
  const scratch = path.join(input.workDir, "pages");
  await mkdir(scratch, { mode: 0o700 });
  const pdf = new PdfWriter(input.outPath);
  await pdf.begin();
  try {
    for (let p = 1; p <= pages; p++) {
      const base = path.join(scratch, "page");
      // -cropbox: render exactly the area the viewer shows (CropBox ∩ MediaBox),
      // so redaction marks land where the attorney drew them and nothing the
      // attorney never saw (outside the crop) is printed into the copy.
      // prlimit caps memory and the page image's size before it is written.
      await run("prlimit", [`--as=${3 * 1024 ** 3}`, `--fsize=${MAX_PIXELS * 3 + 1024}`, "--",
        "pdftoppm", "-r", String(PRODUCE_DPI), "-cropbox", "-f", String(p), "-l", String(p), "-singlefile", input.inputPath, base], { timeoutSec: 120 });
      const file = `${base}.ppm`;
      const img = parsePpm(await readFile(file));
      await rm(file, { force: true });
      paintRedactions(img, input.redactions.filter((r) => r.page === p));
      const stamps: { text: string; corner: "bottom-right"; line: number }[] = [];
      if (input.batesPrefix && input.batesStart !== null) stamps.push({ text: batesNumber(input.batesPrefix, input.batesStart + p - 1), corner: "bottom-right", line: 0 });
      if (input.exhibitLabel && p === 1) stamps.push({ text: `EXHIBIT ${input.exhibitLabel}`, corner: "bottom-right", line: stamps.length });
      await pdf.page(img, stamps);
    }
    await pdf.finish();
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  return { pages, path: input.outPath };
}
