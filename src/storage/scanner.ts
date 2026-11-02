import net from "node:net";
import type { Readable } from "node:stream";

export interface ScanResult {
  status: "clean" | "infected" | "error";
  detail: string;
}

export interface MalwareScanner {
  readonly name: string;
  scan(content: Readable): Promise<ScanResult>;
}

/**
 * ClamAV (clamd) scanner using the INSTREAM protocol over TCP.
 * Files are never opened by anyone until this returns "clean".
 */
export class ClamdScanner implements MalwareScanner {
  readonly name = "ClamAV";
  constructor(private readonly host: string, private readonly port: number, private readonly timeoutMs = 10 * 60_000) {}

  scan(content: Readable): Promise<ScanResult> {
    return new Promise((resolve) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      let reply = "";
      let settled = false;
      const done = (r: ScanResult) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        content.destroy();
        resolve(r);
      };
      socket.setTimeout(this.timeoutMs, () => done({ status: "error", detail: "Malware scan timed out" }));
      socket.on("error", () => done({ status: "error", detail: "Malware scanner unavailable" }));
      socket.on("data", (d) => { reply += d.toString("utf8"); });
      socket.on("end", () => done(parseClamdReply(reply)));
      socket.on("connect", async () => {
        try {
          socket.write("zINSTREAM\0");
          for await (const chunk of content) {
            const buf = chunk as Buffer;
            for (let off = 0; off < buf.length; off += 64 * 1024) {
              const part = buf.subarray(off, off + 64 * 1024);
              const len = Buffer.alloc(4);
              len.writeUInt32BE(part.length, 0);
              if (!socket.write(Buffer.concat([len, part]))) await new Promise((r) => socket.once("drain", r));
            }
          }
          socket.write(Buffer.alloc(4)); // zero-length chunk ends the stream
        } catch {
          done({ status: "error", detail: "Could not read file for scanning" });
        }
      });
    });
  }
}

export function parseClamdReply(reply: string): ScanResult {
  const text = reply.replace(/\0/g, "").trim();
  if (/^stream: OK$/.test(text)) return { status: "clean", detail: "No threats found" };
  const found = /^stream: (.+) FOUND$/.exec(text);
  if (found) return { status: "infected", detail: `Threat detected: ${found[1]}` };
  if (/size limit exceeded/i.test(text)) return { status: "error", detail: "File exceeds scanner size limit" };
  return { status: "error", detail: "Malware scanner returned an unexpected response" };
}

/** Scanner from the environment, or null if none is configured (files then stay held). */
export function scannerFromEnv(): MalwareScanner | null {
  const host = process.env.HUIS_CLAMAV_HOST;
  if (!host) return null;
  return new ClamdScanner(host, Number(process.env.HUIS_CLAMAV_PORT ?? 3310));
}
