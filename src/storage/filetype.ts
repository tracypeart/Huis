/**
 * Identifies a file from its first bytes rather than trusting its name.
 * Used to label evidence accurately and flag disguised files (for example an
 * executable renamed to .pdf).
 */
export interface DetectedType {
  mime: string;
  label: string;
  executable: boolean;
}

const startsWith = (b: Buffer, sig: number[], offset = 0) => sig.every((v, i) => b[offset + i] === v);

export function detectFileType(head: Buffer): DetectedType {
  if (head.length === 0) return { mime: "application/x-empty", label: "Empty file", executable: false };
  if (startsWith(head, [0x25, 0x50, 0x44, 0x46])) return { mime: "application/pdf", label: "PDF", executable: false };
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47])) return { mime: "image/png", label: "PNG image", executable: false };
  if (startsWith(head, [0xff, 0xd8, 0xff])) return { mime: "image/jpeg", label: "JPEG image", executable: false };
  if (startsWith(head, [0x47, 0x49, 0x46, 0x38])) return { mime: "image/gif", label: "GIF image", executable: false };
  if (startsWith(head, [0x49, 0x49, 0x2a, 0x00]) || startsWith(head, [0x4d, 0x4d, 0x00, 0x2a])) {
    return { mime: "image/tiff", label: "TIFF image", executable: false };
  }
  if (startsWith(head, [0x66, 0x74, 0x79, 0x70], 4)) {
    const brand = head.subarray(8, 12).toString("latin1");
    if (/^(heic|heix|mif1|msf1)/.test(brand)) return { mime: "image/heic", label: "HEIC photo", executable: false };
    if (brand.startsWith("qt")) return { mime: "video/quicktime", label: "QuickTime video", executable: false };
    if (/^M4A/.test(brand)) return { mime: "audio/mp4", label: "M4A audio", executable: false };
    return { mime: "video/mp4", label: "MP4 video", executable: false };
  }
  if (startsWith(head, [0x52, 0x49, 0x46, 0x46]) && head.subarray(8, 12).toString("latin1") === "WAVE") {
    return { mime: "audio/wav", label: "WAV audio", executable: false };
  }
  if (startsWith(head, [0x49, 0x44, 0x33]) || startsWith(head, [0xff, 0xfb]) || startsWith(head, [0xff, 0xf3])) {
    return { mime: "audio/mpeg", label: "MP3 audio", executable: false };
  }
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04]) || startsWith(head, [0x50, 0x4b, 0x05, 0x06])) {
    const s = head.toString("latin1");
    if (s.includes("word/")) return { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", label: "Word document", executable: false };
    if (s.includes("xl/")) return { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", label: "Excel workbook", executable: false };
    if (s.includes("ppt/")) return { mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", label: "PowerPoint", executable: false };
    return { mime: "application/zip", label: "ZIP archive (or Office document)", executable: false };
  }
  if (startsWith(head, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    return { mime: "application/x-ole-storage", label: "Legacy Office file or Outlook .msg", executable: false };
  }
  if (startsWith(head, [0x21, 0x42, 0x44, 0x4e])) return { mime: "application/vnd.ms-outlook-pst", label: "Outlook data file (.pst)", executable: false };
  if (startsWith(head, [0x7b, 0x5c, 0x72, 0x74, 0x66])) return { mime: "application/rtf", label: "Rich text", executable: false };
  if (startsWith(head, [0x4d, 0x5a])) return { mime: "application/x-msdownload", label: "Windows executable", executable: true };
  if (startsWith(head, [0x7f, 0x45, 0x4c, 0x46])) return { mime: "application/x-executable", label: "Linux executable", executable: true };
  if (startsWith(head, [0xcf, 0xfa, 0xed, 0xfe]) || startsWith(head, [0xca, 0xfe, 0xba, 0xbe])) {
    return { mime: "application/x-mach-binary", label: "Mac executable", executable: true };
  }
  const text = head.subarray(0, 512).toString("utf8");
  if (/^(From |Received:|Return-Path:|MIME-Version:|Date:|Message-ID:|Subject:)/m.test(text) && /\n(From|To|Subject):/i.test(text)) {
    return { mime: "message/rfc822", label: "Email (.eml)", executable: false };
  }
  if (/^\s*<(!doctype html|html)/i.test(text)) return { mime: "text/html", label: "Web page (HTML)", executable: false };
  if (!head.subarray(0, 512).includes(0)) return { mime: "text/plain", label: "Text", executable: false };
  return { mime: "application/octet-stream", label: "Unknown binary", executable: false };
}
