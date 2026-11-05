import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { pickerPage, pickerScript } from "../src/integrations/google-picker-page";

/**
 * Security review 21 — Phase 9 part 2b (Google Drive in the Integration Hub).
 * Each "R21-N" test asserts the secure behaviour and failed against the code as reviewed. The reviewer's
 * original tests drove the in-app picker component; after the fix the picker is a document of its own, so
 * the tests run its script and check its page instead, asserting the same behaviour.
 */

const ROOT = path.resolve(__dirname, "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
const DRIVE_FILE = "https://www.googleapis.com/auth/drive.file";

/** Runs the picker's script against stand-ins for the page and Google's libraries; returns what it did. */
async function runPicker(grantedScope: string) {
  const els: Record<string, Record<string, unknown>> = {};
  const el = (id: string) => (els[id] ??= {
    id, disabled: false, hidden: false, textContent: "", listeners: {} as Record<string, () => void>,
    addEventListener(type: string, fn: () => void) { (this.listeners as Record<string, () => void>)[type] = fn; },
    submit() { this.submitted = true; },
  });
  const configs: Record<string, unknown>[] = [];
  const tokensUsed: string[] = [];
  const builder: Record<string, unknown> = {};
  for (const m of ["setTitle", "addView", "enableFeature", "setDeveloperKey", "setAppId", "setOrigin", "setCallback"]) builder[m] = () => builder;
  builder.setOAuthToken = (t: string) => { tokensUsed.push(t); return builder; };
  builder.build = () => ({ setVisible: () => undefined });
  const google = {
    accounts: { oauth2: { initTokenClient: (c: Record<string, unknown>) => {
      configs.push(c);
      return { requestAccessToken: (o?: Record<string, unknown>) => {
        if (o) configs.push(o);
        (c.callback as (r: unknown) => void)({ access_token: "BROWSER-AT", scope: grantedScope });
      } };
    } } },
    picker: {
      Action: { PICKED: "picked", CANCEL: "cancel" }, Feature: { MULTISELECT_ENABLED: "m", SUPPORT_DRIVES: "d" }, ViewId: { DOCS: "docs" },
      DocsView: class { setIncludeFolders() { return this; } setSelectFolderEnabled() { return this; } },
      PickerBuilder: function () { return builder; },
    },
  };
  const window = { google, gapi: { load: (_n: string, cb: () => void) => cb() }, location: { origin: "https://huis.example" } };
  const document = { getElementById: el, head: { appendChild: (s: { onload: () => void }) => setTimeout(() => s.onload(), 0) }, createElement: () => ({}) };
  vm.runInNewContext(pickerScript({ clientId: "gc", apiKey: "k", appId: "123", loginHint: null }), { window, document, Promise, setTimeout, String });
  await new Promise((r) => setTimeout(r, 20));
  (els.choose!.listeners as Record<string, () => void>).click!();
  return { configs, tokensUsed, status: String(els.status!.textContent) };
}

describe("Google's file picker in the browser", () => {
  it("R21-1: the browser's picker token is for drive.file only — it never folds in Gmail or other permissions given to the firm's Google app", async () => {
    const ok = await runPicker(`openid ${DRIVE_FILE}`);
    expect(ok.configs[0]).toMatchObject({ scope: DRIVE_FILE, include_granted_scopes: false });
    // Explicitly off in the request too, never on.
    expect(ok.configs.some((c) => c.include_granted_scopes === true)).toBe(false);
    expect(ok.configs[1]).toMatchObject({ include_granted_scopes: false });
    expect(ok.tokensUsed).toEqual(["BROWSER-AT"]);
    // A token that carries Gmail (or full Drive) anyway is never handed to the picker.
    for (const extra of ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/drive"]) {
      const bad = await runPicker(`openid ${DRIVE_FILE} ${extra}`);
      expect(bad.tokensUsed).toEqual([]);
      expect(bad.status).toMatch(/more access/);
    }
    expect((await runPicker("openid email")).tokensUsed).toEqual([]);
  });

  it("R21-2: the picker page's relaxed security policy stays on that page — it is entered and left with full page loads", () => {
    // A security policy belongs to the document; the app's pages switch in place. So the picker is a document
    // of its own (a route handler), not a page of the app with its navigation and next/link.
    expect(existsSync(path.join(ROOT, "app/(app)/integrations/[id]/pick/page.tsx"))).toBe(false);
    const route = read("app/integrations/[id]/pick/route.ts");
    expect(route).not.toMatch(/next\/link|from "react"/);
    // In: the browse page's "Choose files in Google Drive" is a plain link, not next/link.
    const browsePage = read("app/(app)/integrations/[id]/page.tsx");
    const at = browsePage.indexOf("/pick`");
    expect(at).toBeGreaterThan(-1);
    expect(browsePage.slice(browsePage.lastIndexOf("<", at), at)).toMatch(/^<a\b/);
    // Out: every link on the page is a plain link, and choosing files ends in a plain form post (a full load).
    const page = pickerPage({ connectionId: "c1", accountLabel: "avery@x.example", picker: { clientId: "gc", apiKey: "k", appId: "1" }, message: null });
    expect(page).toMatch(/^<!doctype html>/);
    expect(page).toContain('<form method="post" id="picked">');
    expect(page).not.toMatch(/requestSubmit|_next\//);
    expect([...page.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1])).toEqual(["/integrations/c1", "/integrations/c1"]);
    // The account name can't break out of the page or its script.
    const evil = pickerPage({ connectionId: "c1", accountLabel: "</script><script>alert(1)</script>@x", picker: { clientId: "gc", apiKey: "k", appId: "1" }, message: null });
    expect(evil).not.toContain("<script>alert(1)");
    // The relaxed policy is still matched to that one path.
    expect(read("next.config.ts")).toContain('{ source: "/integrations/:id/pick", headers: googlePickerHeaders }');
    // The finishing post is accepted only from this site's own page.
    expect(route).toMatch(/headers\.get\("origin"\) !== new URL\(cfg\.baseUrl\)\.origin/);
  });
});
