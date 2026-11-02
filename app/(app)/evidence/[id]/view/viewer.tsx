"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Kind = "highlight" | "note" | "redaction";
interface Mark {
  id: string; page: number; kind: Kind; x: number; y: number; w: number; h: number;
  note: string | null; createdByName: string | null; mine: boolean;
}
type Tool = "none" | Kind;
interface Draft { page: number; x: number; y: number; w: number; h: number }

const KIND_LABEL: Record<Kind, string> = { highlight: "Highlight", note: "Note", redaction: "Redact" };

/**
 * Page viewer. pdf.js renders the document to a canvas (document scripts and
 * XFA forms are never run); marks are drawn as an overlay positioned in fractions of
 * the page, so they line up at any zoom. Marks are firm work product: they
 * are only loaded for firm staff, and the server enforces it.
 */
export function Viewer({ evidenceId, staff, canMark }: { evidenceId: string; staff: boolean; canMark: boolean }) {
  const [doc, setDoc] = useState<{ numPages: number; getPage: (n: number) => Promise<any> } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [tool, setTool] = useState<Tool>("none");
  const [marks, setMarks] = useState<Mark[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pendingNote, setPendingNote] = useState<Draft | null>(null);
  const [noteText, setNoteText] = useState("");
  const [busy, setBusy] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  // Draw form fields and annotations into the page image, exactly as copies are
  // produced, so nothing appears in a copy that wasn't visible (and redactable) here.
  const annotationMode = useRef<number | undefined>(undefined);

  // Load the document.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        annotationMode.current = pdfjs.AnnotationMode.ENABLE;
        pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.mjs";
        const task = pdfjs.getDocument({
          url: `/api/evidence/${evidenceId}/view`,
          enableXfa: false, disableAutoFetch: true, withCredentials: true,
        });
        const d = await task.promise;
        if (!cancelled) setDoc(d as never);
      } catch {
        if (!cancelled) setError("This document couldn't be displayed. You can still download the original.");
      }
    })();
    return () => { cancelled = true; };
  }, [evidenceId]);

  const loadMarks = useCallback(async () => {
    if (!staff) return;
    const r = await fetch(`/api/evidence/${evidenceId}/annotations`, { cache: "no-store" });
    if (r.ok) setMarks((await r.json()).annotations as Mark[]);
  }, [evidenceId, staff]);
  useEffect(() => { void loadMarks(); }, [loadMarks]);

  // Render the current page.
  useEffect(() => {
    if (!doc || !canvasRef.current) return;
    let task: { cancel: () => void; promise: Promise<void> } | null = null;
    let cancelled = false;
    (async () => {
      const p = await doc.getPage(page);
      if (cancelled) return;
      const base = p.getViewport({ scale: 1 });
      // Fit the page inside the stage (its width minus its 16px padding on each side).
      const available = Math.min(1000, (overlayRef.current?.parentElement?.parentElement?.clientWidth ?? 900) - 36);
      const scale = (available / base.width) * zoom;
      const viewport = p.getViewport({ scale });
      const ratio = window.devicePixelRatio || 1;
      const canvas = canvasRef.current!;
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      const ctx = canvas.getContext("2d")!;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      task = p.render({ canvasContext: ctx, viewport, canvas, annotationMode: annotationMode.current });
      await task!.promise.catch(() => undefined);
    })();
    return () => { cancelled = true; task?.cancel(); };
  }, [doc, page, zoom]);

  const frac = (e: React.PointerEvent) => {
    const r = overlayRef.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  const onDown = (e: React.PointerEvent) => {
    if (tool === "none" || !canMark || pendingNote) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    start.current = frac(e);
    setDraft({ page, ...start.current, w: 0, h: 0 });
  };
  const onMove = (e: React.PointerEvent) => {
    if (!start.current) return;
    const p = frac(e);
    setDraft({ page, x: Math.min(start.current.x, p.x), y: Math.min(start.current.y, p.y), w: Math.abs(p.x - start.current.x), h: Math.abs(p.y - start.current.y) });
  };
  const onUp = async () => {
    const d = draft;
    start.current = null;
    setDraft(null);
    if (!d || d.w < 0.005 || d.h < 0.005 || tool === "none") return;
    if (tool === "note") { setPendingNote(d); setNoteText(""); return; }
    await save({ ...d, kind: tool });
  };

  const save = async (m: Draft & { kind: Kind; note?: string }) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/evidence/${evidenceId}/annotations`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(m),
      });
      if (!r.ok) setError((await r.json().catch(() => ({}))).error ?? "The mark couldn't be saved.");
      await loadMarks();
    } finally {
      setBusy(false);
    }
  };
  const remove = async (id: string) => {
    setBusy(true);
    try {
      const r = await fetch(`/api/evidence/${evidenceId}/annotations/${id}`, { method: "DELETE" });
      if (!r.ok) setError((await r.json().catch(() => ({}))).error ?? "The mark couldn't be removed.");
      await loadMarks();
    } finally {
      setBusy(false);
    }
  };

  const onPage = marks.filter((m) => m.page === page);
  const pct = (v: number) => `${(v * 100).toFixed(3)}%`;

  return (
    <div className="viewer">
      <div className="viewer-toolbar">
        <button type="button" className="secondary" disabled={!doc || page <= 1} onClick={() => setPage((p) => p - 1)}>‹ Previous</button>
        <span>Page {page} of {doc?.numPages ?? "…"}</span>
        <button type="button" className="secondary" disabled={!doc || page >= (doc?.numPages ?? 1)} onClick={() => setPage((p) => p + 1)}>Next ›</button>
        <span className="viewer-sep" />
        <button type="button" className="secondary" onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))} aria-label="Zoom out">−</button>
        <span>{Math.round(zoom * 100)}%</span>
        <button type="button" className="secondary" onClick={() => setZoom((z) => Math.min(3, z + 0.25))} aria-label="Zoom in">+</button>
        {canMark ? (
          <>
            <span className="viewer-sep" />
            {(["highlight", "note", "redaction"] as Kind[]).map((k) => (
              <button key={k} type="button" className={tool === k ? "" : "secondary"} aria-pressed={tool === k}
                onClick={() => setTool((t) => (t === k ? "none" : k))}>{KIND_LABEL[k]}</button>
            ))}
            {tool !== "none" ? <span className="notice">Drag on the page to {tool === "redaction" ? "mark an area to redact" : `add a ${tool}`}.</span> : null}
          </>
        ) : null}
      </div>
      {error ? <div className="flash error" role="alert">{error}</div> : null}

      <div className="viewer-body">
        <div className="viewer-stage">
          <div className="viewer-page" style={{ cursor: tool !== "none" && canMark ? "crosshair" : "default" }}>
            <canvas ref={canvasRef} />
            <div ref={overlayRef} className="viewer-overlay" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}>
              {onPage.map((m) => (
                <div key={m.id} className={`mark mark-${m.kind}`} title={m.note ?? KIND_LABEL[m.kind]}
                  style={{ left: pct(m.x), top: pct(m.y), width: pct(m.w), height: pct(m.h) }} />
              ))}
              {draft ? <div className={`mark mark-${tool} mark-draft`} style={{ left: pct(draft.x), top: pct(draft.y), width: pct(draft.w), height: pct(draft.h) }} /> : null}
              {pendingNote ? <div className="mark mark-note mark-draft" style={{ left: pct(pendingNote.x), top: pct(pendingNote.y), width: pct(pendingNote.w), height: pct(pendingNote.h) }} /> : null}
            </div>
          </div>
        </div>

        {staff ? (
          <aside className="viewer-side card">
            <h2>Marks on this page</h2>
            <p className="notice">Firm work product: never visible to clients or anyone outside the firm.</p>
            {pendingNote ? (
              <div className="viewer-note-form">
                <label>Note
                  <textarea value={noteText} maxLength={5000} rows={4} onChange={(e) => setNoteText(e.target.value)} autoFocus />
                </label>
                <div className="row">
                  <button type="button" disabled={busy || !noteText.trim()} onClick={async () => { const d = pendingNote; setPendingNote(null); await save({ ...d, kind: "note", note: noteText.trim() }); }}>Save note</button>
                  <button type="button" className="secondary" onClick={() => setPendingNote(null)}>Cancel</button>
                </div>
              </div>
            ) : null}
            {onPage.length === 0 ? <p className="notice">None.</p> : (
              <ul className="viewer-marks">
                {onPage.map((m) => (
                  <li key={m.id}>
                    <span className={`swatch swatch-${m.kind}`} aria-hidden="true" /> <strong>{KIND_LABEL[m.kind]}</strong>
                    {m.note ? <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{m.note}</div> : null}
                    <div className="notice">{m.createdByName ?? "Someone"}{m.mine ? " (you)" : ""}</div>
                    {canMark ? <button type="button" className="link" disabled={busy} onClick={() => remove(m.id)}>Remove</button> : null}
                  </li>
                ))}
              </ul>
            )}
            <p className="notice">{marks.filter((m) => m.kind === "redaction").length} area(s) marked for redaction in this document.</p>
          </aside>
        ) : null}
      </div>
    </div>
  );
}
