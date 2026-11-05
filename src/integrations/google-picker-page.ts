import { DRIVE_FILE_SCOPE } from "./google-drive";

/**
 * Google Drive's file picker page (Integration Hub, Phase 9 part 2b).
 *
 * Served as a document of its own, not as part of the app's pages: it is the only page whose security
 * policy allows Google's picker and sign-in hosts, and a policy belongs to the document. Pages of the
 * app switch in place without loading a new document, so the picker page is entered, left and finished
 * with full page loads only (security review 21, R21-2): plain links in and out, and a plain form post
 * once files are chosen.
 *
 * The token the picker uses is asked for in the person's browser, from Google, for drive.file only. It is
 * never sent to Huis. Gmail uses the same Google app, so the request explicitly leaves out permissions
 * given to it before, and a token carrying anything else is refused (security review 21, R21-1).
 */

export interface PickerPageInput {
  connectionId: string;
  accountLabel: string | null;
  /** Null when the picker isn't set up for the firm, or the account needs reconnecting (message shown instead). */
  picker: { clientId: string; apiKey: string; appId: string } | null;
  message: string | null;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
/** JSON safe to place inside a <script> element. */
const js = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

/** What a picker token may carry: drive.file, and the sign-in basics Google may add. */
export const PICKER_ALLOWED_SCOPES = [DRIVE_FILE_SCOPE, "openid", "email", "https://www.googleapis.com/auth/userinfo.email"];

/**
 * The script that runs the picker. Kept as a function of its config so it can be tested on its own.
 * It expects the page's "#choose", "#status" and "#picked" (form) elements.
 */
export function pickerScript(cfg: { clientId: string; apiKey: string; appId: string; loginHint: string | null }): string {
  return `(function () {
  var cfg = ${js({ ...cfg, scope: DRIVE_FILE_SCOPE, allowed: PICKER_ALLOWED_SCOPES })};
  var button = document.getElementById("choose");
  var status = document.getElementById("status");
  var token = null;
  function say(t) { status.textContent = t; }
  function load(src) {
    return new Promise(function (ok, fail) {
      var s = document.createElement("script");
      s.src = src; s.async = true; s.onload = function () { ok(); };
      s.onerror = function () { fail(new Error("Google's file picker couldn't be loaded. Check your connection and reload this page.")); };
      document.head.appendChild(s);
    });
  }
  function onlyDriveFile(r) {
    var granted = String(r.scope || "").split(" ").filter(Boolean);
    if (granted.indexOf(cfg.scope) < 0) return false;
    for (var i = 0; i < granted.length; i++) if (cfg.allowed.indexOf(granted[i]) < 0) return false;
    return true;
  }
  function show() {
    var p = window.google.picker;
    var view = new p.DocsView(p.ViewId.DOCS);
    view.setIncludeFolders(true);
    view.setSelectFolderEnabled(false);
    new p.PickerBuilder().setTitle("Choose files for Huis").addView(view)
      .enableFeature(p.Feature.MULTISELECT_ENABLED).enableFeature(p.Feature.SUPPORT_DRIVES)
      .setOAuthToken(token).setDeveloperKey(cfg.apiKey).setAppId(cfg.appId).setOrigin(window.location.origin)
      .setCallback(function (r) {
        if (r.action === p.Action.PICKED) {
          token = null;
          button.disabled = true;
          say("Got it. Huis is listing the files you chose\\u2026");
          // A full page load (not an in-page switch), so this page's policy ends here.
          document.getElementById("picked").submit();
        }
      }).build().setVisible(true);
  }
  button.addEventListener("click", function () {
    if (token) { show(); return; }
    button.disabled = true;
    say("Waiting for Google\\u2026");
    var request = { prompt: "", include_granted_scopes: false };
    window.google.accounts.oauth2.initTokenClient({
      client_id: cfg.clientId, scope: cfg.scope, include_granted_scopes: false,
      login_hint: cfg.loginHint || undefined,
      callback: function (r) {
        button.disabled = false;
        if (!r || !r.access_token) { say("Google didn't give permission to choose files."); return; }
        if (!onlyDriveFile(r)) { say("Google gave this page more access than Huis asks for, so it wasn't used. Please try again."); return; }
        token = r.access_token;
        say("");
        show();
      },
      error_callback: function () { button.disabled = false; say("The Google window was closed before you chose any files."); }
    }).requestAccessToken(request);
  });
  Promise.all([load("https://accounts.google.com/gsi/client"), load("https://apis.google.com/js/api.js")])
    .then(function () { return new Promise(function (ok) { window.gapi.load("picker", ok); }); })
    .then(function () { button.disabled = false; button.textContent = "Choose files in Google Drive"; })
    .catch(function (e) { button.hidden = true; say(e.message); });
})();`;
}

export function pickerPage(p: PickerPageInput): string {
  const back = `/integrations/${encodeURIComponent(p.connectionId)}`;
  const account = esc(p.accountLabel ?? "the account you connected");
  const body = p.picker ? `
    <p>Google's file picker opens in a window from Google. Sign in with <strong>${account}</strong> if Google asks, and choose the files Huis may open. Nothing is copied yet: you'll tick which ones to import into a Matter next.</p>
    <p><button type="button" id="choose" disabled>Loading Google's file picker…</button> <a href="${back}">Back</a></p>
    <p class="notice" id="status" role="status"></p>
    <form method="post" id="picked"></form>
    <p class="notice">Google Docs, Sheets and Slides can't be imported yet: download them as a file (such as PDF or Word) first.</p>
    <script>${pickerScript({ ...p.picker, loginHint: p.accountLabel && p.accountLabel.includes("@") ? p.accountLabel : null })}</script>`
    : `<p>${esc(p.message ?? "Google's file picker isn't available.")}</p><p><a href="${back}">Back</a></p>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Choose files for Huis</title>
<style>
  :root { color-scheme: light; --ink: #14213d; --muted: #5b6475; --line: #dde2ea; --bg: #f5f7fa; --brand: #1f3557; }
  body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--ink); }
  main { max-width: 760px; margin: 0 auto; padding: 32px 16px; }
  h1 { font-size: 1.6rem; margin: 0 0 4px; } .sub { color: var(--muted); margin: 0 0 20px; }
  .card { background: #fff; border: 1px solid var(--line); border-radius: 10px; padding: 20px; }
  .notice { color: var(--muted); font-size: .9rem; } a { color: #1d5fa8; }
  button { font: inherit; background: var(--brand); color: #fff; border: 0; border-radius: 6px; padding: 10px 16px; cursor: pointer; }
  button:disabled { opacity: .6; cursor: default; }
</style></head>
<body><main>
  <p class="notice"><a href="${back}">← Google Drive</a></p>
  <h1>Choose files for Huis</h1>
  <p class="sub">${esc(p.accountLabel ?? "Connected account")} · Huis can open only the files you choose here</p>
  <div class="card">${body}</div>
</main></body></html>`;
}
