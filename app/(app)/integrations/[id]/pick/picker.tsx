"use client";

import { useEffect, useRef, useState } from "react";

/* Google's scripts, as much of them as Huis uses. */
interface TokenResponse { access_token?: string; error?: string }
interface PickerResult { action: string }
interface GoogleGlobal {
  accounts: { oauth2: { initTokenClient(c: { client_id: string; scope: string; login_hint?: string; callback: (r: TokenResponse) => void; error_callback?: (e: { type?: string }) => void }): { requestAccessToken(o?: { prompt?: string }): void } } };
  picker: {
    Action: { PICKED: string; CANCEL: string };
    Feature: { MULTISELECT_ENABLED: string; SUPPORT_DRIVES: string };
    ViewId: { DOCS: string };
    DocsView: new (viewId?: string) => { setIncludeFolders(b: boolean): unknown; setSelectFolderEnabled(b: boolean): unknown; setOwnedByMe?(b: boolean): unknown };
    PickerBuilder: new () => PickerBuilder;
  };
}
interface PickerBuilder {
  addView(v: unknown): PickerBuilder; enableFeature(f: string): PickerBuilder; setOAuthToken(t: string): PickerBuilder;
  setDeveloperKey(k: string): PickerBuilder; setAppId(a: string): PickerBuilder; setOrigin(o: string): PickerBuilder;
  setCallback(cb: (r: PickerResult) => void): PickerBuilder; setTitle(t: string): PickerBuilder; build(): { setVisible(v: boolean): void };
}
declare global { interface Window { google?: GoogleGlobal; gapi?: { load(name: string, cb: () => void): void } } }

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const s = document.createElement("script");
    s.src = src; s.async = true; s.onload = () => resolve(); s.onerror = () => reject(new Error("Google's file picker couldn't be loaded."));
    document.head.appendChild(s);
  });
}

/**
 * Opens Google's file picker. The token it uses comes from Google straight to this browser, for drive.file
 * only, and is never sent to Huis: choosing a file is what lets Huis's own (server-side) connection open it.
 */
export function GooglePicker({ clientId, apiKey, appId, scope, loginHint, backTo }: {
  clientId: string; apiKey: string; appId: string; scope: string; loginHint: string | null; backTo: string;
}) {
  const [state, setState] = useState<"loading" | "ready" | "working" | "done" | "error">("loading");
  const [message, setMessage] = useState<string | null>(null);
  const token = useRef<string | null>(null);

  useEffect(() => {
    let live = true;
    Promise.all([loadScript("https://accounts.google.com/gsi/client"), loadScript("https://apis.google.com/js/api.js")])
      .then(() => new Promise<void>((resolve) => window.gapi!.load("picker", () => resolve())))
      .then(() => { if (live) setState("ready"); })
      .catch((e: Error) => { if (live) { setState("error"); setMessage(e.message); } });
    return () => { live = false; };
  }, []);

  function show(accessToken: string) {
    const g = window.google!;
    const view = new g.picker.DocsView(g.picker.ViewId.DOCS);
    view.setIncludeFolders(true);
    view.setSelectFolderEnabled(false);
    new g.picker.PickerBuilder()
      .setTitle("Choose files for Huis")
      .addView(view)
      .enableFeature(g.picker.Feature.MULTISELECT_ENABLED)
      .enableFeature(g.picker.Feature.SUPPORT_DRIVES)
      .setOAuthToken(accessToken)
      .setDeveloperKey(apiKey)
      .setAppId(appId)
      .setOrigin(window.location.origin)
      .setCallback((r) => {
        if (r.action === g.picker.Action.PICKED) {
          token.current = null;
          setState("done");
          // Huis lists the chosen files again (the server asks Google, with its own connection).
          (document.getElementById("picked") as HTMLFormElement | null)?.requestSubmit();
        } else if (r.action === g.picker.Action.CANCEL) {
          setState("ready");
        }
      })
      .build()
      .setVisible(true);
  }

  function open() {
    const g = window.google;
    if (!g) return;
    if (token.current) { show(token.current); return; }
    setState("working");
    g.accounts.oauth2.initTokenClient({
      client_id: clientId, scope, ...(loginHint ? { login_hint: loginHint } : {}),
      callback: (r) => {
        if (!r.access_token) { setState("ready"); setMessage("Google didn't give permission to choose files."); return; }
        token.current = r.access_token;
        setState("ready");
        show(r.access_token);
      },
      error_callback: () => { setState("ready"); setMessage("The Google window was closed before you chose any files."); },
    }).requestAccessToken({ prompt: "" });
  }

  return (
    <div style={{ margin: "12px 0" }}>
      {state === "error" ? <p className="notice">{message} Check your connection and reload this page. <a href={backTo}>Back</a></p>
        : state === "done" ? <p className="notice">Got it. Huis is listing the files you chose…</p> : (
        <p>
          <button type="button" onClick={open} disabled={state !== "ready"}>
            {state === "loading" ? "Loading Google's file picker…" : state === "working" ? "Waiting for Google…" : "Choose files in Google Drive"}
          </button>{" "}
          <a href={backTo}>Back</a>
        </p>
      )}
      {message && state !== "error" ? <p className="notice">{message}</p> : null}
    </div>
  );
}
