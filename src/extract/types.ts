/** Shared types for text extraction. */

export interface ExtractInput {
  /** Decrypted copy in a private temporary folder. */
  inputPath: string;
  /** Folder where any contained files (attachments, archive entries) are written. */
  outDir: string;
  filename: string;
  /** From the security scan's content check (e.g. "PDF", "Email (.eml)"). */
  detectedType: string | null;
  /** How deep inside other containers this file already is. */
  depth: number;
}

export interface EmailHeaders {
  from: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string | null;
  /** ISO 8601 */
  date: string | null;
  messageId: string | null;
  inReplyTo: string | null;
}

export interface ContainedFile {
  /** File written inside outDir by the extractor (never a user-controlled path). */
  path: string;
  filename: string;
  /** Where it was inside the container, e.g. "Attachment 2" or "Scans/2024/page1.pdf". */
  containerPath: string;
  declaredType: string | null;
}

export type ExtractStatus = "done" | "partial" | "no_text" | "unsupported" | "needs_provider";

export interface ExtractResult {
  status: ExtractStatus;
  detail: string;
  text: string;
  method: "native" | "ocr" | "transcript" | "mixed";
  pages: number | null;
  email: EmailHeaders | null;
  children: ContainedFile[];
}

/** Hard limits applied to every file. */
export const LIMITS = {
  /** Text kept per item (characters). */
  maxTextChars: 5_000_000,
  /** Pages OCR'd per PDF. */
  maxOcrPages: 300,
  /** Files taken out of one archive or email. */
  maxChildren: 10_000,
  /** Total bytes unpacked from one archive (the database also caps everything unpacked from one upload). */
  maxUnpackedBytes: 5 * 1024 ** 3,
  /** Largest single unpacked file. */
  maxChildBytes: 10 * 1024 ** 3,
  /** Unpacked/packed size ratio above which an entry is treated as a zip bomb. */
  maxCompressionRatio: 200,
  /** Nesting (zip in email in zip …). */
  maxDepth: 4,
  /** Seconds per external tool run. */
  toolTimeoutSec: 300,
  /** Seconds of OCR per file before saving what was read (below the sandbox limit). */
  ocrBudgetSec: 35 * 60,
};
