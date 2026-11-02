"use client";

import { useRouter } from "next/navigation";
import { useCallback, useRef, useState } from "react";

interface Folder { id: string; name: string; isPrivilegedArea: boolean }
interface Props {
  matterId: string;
  folders: Folder[];
  defaultFolderId: string;
  isClient: boolean;
}

interface Pick { file: File; relativePath: string | null }
interface Row { key: string; name: string; size: number; sent: number; state: "waiting" | "uploading" | "done" | "error"; message?: string }

const SOURCES: [string, string][] = [
  ["upload", "Uploaded file"],
  ["external_drive", "USB / thumb drive / external drive"],
  ["discovery_production", "Discovery production"],
  ["court", "Court download"],
  ["email", "Saved email"],
  ["cloud_drive", "Downloaded from a cloud drive"],
];
const PARALLEL_CHUNKS = 3;
const MAX_RETRIES = 4;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024; let u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u += 1; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[u]}`;
}

/** Reads every file inside a dropped folder (e.g. a whole thumb drive). */
async function filesFromEntry(entry: FileSystemEntry, prefix = ""): Promise<Pick[]> {
  if (entry.isFile) {
    const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
    return [{ file, relativePath: prefix ? `${prefix}${file.name}` : null }];
  }
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  const out: Pick[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
    if (batch.length === 0) break;
    for (const child of batch) out.push(...(await filesFromEntry(child, `${prefix}${entry.name}/`)));
  }
  return out;
}

async function send(url: string, init: RequestInit): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { ...init, credentials: "same-origin" });
      const body = await res.json().catch(() => ({}));
      if (res.ok) return body;
      if (res.status < 500 || attempt >= MAX_RETRIES) throw new Error(body.error ?? `Upload failed (${res.status})`);
    } catch (err) {
      if (attempt >= MAX_RETRIES) throw err;
    }
    await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
  }
}

export default function EvidenceUploader({ matterId, folders, defaultFolderId, isClient }: Props) {
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const meta = useRef<{ folderId: string; source: string; receivedFrom: string; dateReceived: string }>({
    folderId: defaultFolderId, source: isClient ? "upload" : "upload", receivedFrom: "", dateReceived: "",
  });
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  const update = (key: string, patch: Partial<Row>) => setRows((r) => r.map((x) => (x.key === key ? { ...x, ...patch } : x)));

  const uploadOne = useCallback(async (p: Pick, key: string) => {
    const m = meta.current;
    update(key, { state: "uploading" });
    const session = await send("/api/uploads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        matterId, folderId: m.folderId, filename: p.file.name, relativePath: p.relativePath ?? undefined,
        declaredType: p.file.type || undefined, totalSize: p.file.size,
        source: p.relativePath && m.source === "upload" ? "folder_upload" : m.source,
        receivedFrom: m.receivedFrom || undefined, dateReceived: m.dateReceived || undefined,
      }),
    });
    const queue = Array.from({ length: session.chunkCount }, (_, i) => i);
    let sent = 0;
    const worker = async () => {
      for (let i = queue.shift(); i !== undefined; i = queue.shift()) {
        const blob = p.file.slice(i * session.chunkSize, (i + 1) * session.chunkSize);
        await send(`/api/uploads/${session.id}/chunks/${i}`, { method: "PUT", body: blob });
        sent += blob.size;
        update(key, { sent });
      }
    };
    await Promise.all(Array.from({ length: PARALLEL_CHUNKS }, worker));
    await send(`/api/uploads/${session.id}/complete`, { method: "POST" });
    update(key, { state: "done", sent: p.file.size });
  }, [matterId]);

  const start = useCallback(async (picks: Pick[]) => {
    if (picks.length === 0) return;
    const base = Date.now();
    const newRows: Row[] = picks.map((p, i) => ({ key: `${base}-${i}`, name: p.relativePath ?? p.file.name, size: p.file.size, sent: 0, state: "waiting" }));
    setRows((r) => [...newRows, ...r]);
    setBusy(true);
    for (let i = 0; i < picks.length; i++) {
      try {
        await uploadOne(picks[i]!, newRows[i]!.key);
      } catch (err) {
        update(newRows[i]!.key, { state: "error", message: err instanceof Error ? err.message : "Upload failed" });
      }
    }
    setBusy(false);
    router.refresh();
  }, [router, uploadOne]);

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDrag(false);
    const items = Array.from(e.dataTransfer.items ?? []);
    const entries = items.map((it) => it.webkitGetAsEntry?.()).filter(Boolean) as FileSystemEntry[];
    const picks = entries.length
      ? (await Promise.all(entries.map((en) => filesFromEntry(en)))).flat()
      : Array.from(e.dataTransfer.files).map((file) => ({ file, relativePath: null }));
    void start(picks);
  };

  const fromInput = (list: FileList | null) => {
    const picks = Array.from(list ?? []).map((file) => ({
      file, relativePath: (file as File & { webkitRelativePath?: string }).webkitRelativePath || null,
    }));
    void start(picks);
  };

  const done = rows.filter((r) => r.state === "done").length;

  return (
    <div>
      {!isClient ? (
        <div className="row" style={{ marginBottom: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
          <label>Put in folder
            <select defaultValue={defaultFolderId} onChange={(e) => { meta.current.folderId = e.target.value; }}>
              {folders.map((f) => <option key={f.id} value={f.id}>{f.isPrivilegedArea ? "🔴 " : ""}{f.name}</option>)}
            </select>
          </label>
          <label>Where it came from
            <select defaultValue="upload" onChange={(e) => { meta.current.source = e.target.value; }}>
              {SOURCES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <label>Received from (person or firm)
            <input maxLength={300} placeholder="e.g. Client, opposing counsel" onChange={(e) => { meta.current.receivedFrom = e.target.value; }} />
          </label>
          <label>Date received
            <input type="date" onChange={(e) => { meta.current.dateReceived = e.target.value; }} />
          </label>
        </div>
      ) : null}

      <div
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
        style={{
          border: `2px dashed ${drag ? "var(--accent)" : "var(--line)"}`, borderRadius: 8, padding: 28, textAlign: "center",
          background: drag ? "#eef6fb" : "#fafbfc",
        }}
      >
        <p style={{ margin: "0 0 12px" }}><strong>Drag files or whole folders here</strong> — including everything on a thumb drive.</p>
        <button type="button" className="secondary" onClick={() => fileInput.current?.click()} disabled={busy}>Choose files</button>{" "}
        <button type="button" className="secondary" onClick={() => folderInput.current?.click()} disabled={busy}>Choose a folder or drive</button>
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => { fromInput(e.target.files); e.target.value = ""; }} />
        <input
          ref={folderInput} type="file" multiple hidden
          // @ts-expect-error non-standard attributes for folder selection
          webkitdirectory="" directory=""
          onChange={(e) => { fromInput(e.target.files); e.target.value = ""; }}
        />
        <p className="notice" style={{ marginTop: 12 }}>
          Files are encrypted, fingerprinted (SHA-256) and scanned for viruses. The original is never changed.
          {isClient ? " Your files go to your attorney's Client Uploads folder." : ""}
        </p>
      </div>

      {rows.length ? (
        <div style={{ marginTop: 12 }}>
          <p className="notice">{done} of {rows.length} uploaded{busy ? " — keep this page open" : ""}.</p>
          <table>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td style={{ wordBreak: "break-all" }}>{r.name}</td>
                  <td style={{ whiteSpace: "nowrap" }}>{formatBytes(r.size)}</td>
                  <td style={{ width: 200 }}>
                    {r.state === "error" ? <span className="badge privileged">{r.message}</span>
                      : r.state === "done" ? <span className="badge">Uploaded — scanning</span>
                      : <progress max={Math.max(r.size, 1)} value={r.sent} style={{ width: "100%" }} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
