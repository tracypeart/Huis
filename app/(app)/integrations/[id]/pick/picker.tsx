"use client";

import { useEffect, useRef, useState } from "react";
import { integrationPickAction } from "../../../../../lib/actions";

/* Google's browser libraries (loaded from Google, typed loosely). */
type AnyFn = (...args: unknown[]) => unknown;
declare global {
  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    gapi?: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    google?: any;
  }
}

const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const FILE_ID = /^[A-Za-z0-9_-]{10,200}$/;

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const el = document.createElement("script");
    el.src = src;
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error("load failed"));
    document.head.appendChild(el);
  });
}

/**
 * Google's own file picker. It runs entirely in this browser with a short-lived token limited to
 * drive.file (only the files chosen); that token is never sent to Huis. Huis receives only the
 * chosen files' ids, and its worker checks each one with the connection's own sealed sign-in.
 */
export function GooglePicker(p: { connectionId: string; matterId: string | null; clientId: string; apiKey: string; appId: string; hint: string | null; origin: string }) {
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [picked, setPicked] = useState<{ id: string; name: string }[]>([]);
  const form = useRef<HTMLFormElement>(null);
  const token = useRef<string | null>(null);
  const tokenClient = useRef<{ requestAccessToken: AnyFn } | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([loadScript("https://accounts.google.com/gsi/client"), loadScript("https://apis.google.com/js/api.js")])
      .then(() => new Promise<void>((resolve) => window.gapi.load("picker", { callback: () => resolve() })))
      .then(() => {
        if (cancelled) return;
        tokenClient.current = window.google.accounts.oauth2.initTokenClient({
          client_id: p.clientId,
          scope: DRIVE_FILE_SCOPE,
          ...(p.hint ? { hint: p.hint } : {}),
          callback: (resp: { access_token?: string; error?: string }) => {
            if (!resp.access_token) { setState("error"); return; }
            token.current = resp.access_token;
            show();
          },
        });
        setState("ready");
      })
      .catch(() => { if (!cancelled) setState("error"); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (picked.length) form.current?.requestSubmit();
  }, [picked]);

  function show() {
    const g = window.google.picker;
    const mine = new g.DocsView(g.ViewId.DOCS).setIncludeFolders(true).setSelectFolderEnabled(false);
    const shared = new g.DocsView(g.ViewId.DOCS).setEnableDrives(true).setIncludeFolders(true).setSelectFolderEnabled(false);
    new g.PickerBuilder()
      .addView(mine)
      .addView(shared)
      .enableFeature(g.Feature.MULTISELECT_ENABLED)
      .enableFeature(g.Feature.SUPPORT_DRIVES)
      .setMaxItems(200)
      .setOAuthToken(token.current)
      .setDeveloperKey(p.apiKey)
      .setAppId(p.appId)
      .setOrigin(p.origin)
      .setTitle("Choose files to import into Huis")
      .setCallback((data: { action?: string; docs?: { id?: string; name?: string }[] }) => {
        if (data.action !== g.Action.PICKED) return;
        const files = (data.docs ?? [])
          .filter((d) => typeof d.id === "string" && FILE_ID.test(d.id))
          .map((d) => ({ id: d.id as string, name: String(d.name ?? "").slice(0, 300) }))
          .slice(0, 200);
        if (files.length) setPicked(files);
      })
      .build()
      .setVisible(true);
  }

  function open() {
    if (token.current) show();
    else tokenClient.current?.requestAccessToken({ prompt: "" });
  }

  return (
    <>
      {state === "error" ? (
        <p className="notice">Google&apos;s file picker couldn&apos;t be loaded. Check that pop-ups are allowed for Huis and that you&apos;re online, then reload this page.</p>
      ) : (
        <button type="button" onClick={open} disabled={state !== "ready" || picked.length > 0}>
          {state === "loading" ? "Loading Google's file picker…" : picked.length ? "Sending your choice to Huis…" : "Open Google's file picker"}
        </button>
      )}
      <form ref={form} action={integrationPickAction} hidden>
        <input type="hidden" name="connectionId" value={p.connectionId} />
        {p.matterId ? <input type="hidden" name="matterId" value={p.matterId} /> : null}
        {picked.map((f) => <input key={f.id} type="hidden" name="file" value={f.id} />)}
      </form>
    </>
  );
}
