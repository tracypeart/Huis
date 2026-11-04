const { chromium } = require("playwright");
const fs = require("fs");
const s = require(require("path").resolve(process.env.HUIS_QA_STATE ?? "qa-state.json"));
const BASE = process.env.HUIS_QA_BASE ?? "http://localhost:3100";
const SKIP = [/^\/api\/auth\/signout/, /^\/api\/auth\/microsoft\/start/];
(async () => {
  const browser = await chromium.launch();
  const report = {};
  for (const [role, cookie] of Object.entries(s.cookies)) {
    const ctx = await browser.newContext({ viewport: { width: 1300, height: 900 } });
    await ctx.addCookies([{ name: "huis_session", value: cookie, domain: "localhost", path: "/", httpOnly: true }]);
    const page = await ctx.newPage();
    let current = "";
    const problems = [];
    page.on("console", (m) => { if (m.type() === "error") problems.push({ url: current, kind: "console", text: m.text().slice(0, 300) }); });
    page.on("pageerror", (e) => problems.push({ url: current, kind: "pageerror", text: e.message.slice(0, 300) }));
    const seeds = ["/dashboard", "/matters", "/matters/new", "/inbox", "/search", "/search?q=FMLA", "/clients", "/contacts", "/users", "/audit",
      `/matters/${s.matterId}`, `/matters/${s.matterId}/brain`, `/matters/${s.matterId}/brain?a=${s.answerId}`, `/matters/${s.matterId}/dna`, `/matters/${s.matterId}/timeline`, `/matters/${s.matterId}/timeline?category=employment&show=confirmed`, `/matters/${s.walledId}/timeline`, `/matters/${s.matterId}/contradictions`, `/matters/${s.walledId}/contradictions`, `/matters/${s.matterId}/workspace`, `/matters/${s.walledId}/workspace`, "/prompts",
      `/matters/${s.matterId}/dna/${s.claimId}`, `/matters/${s.walledId}`, `/inbox/mailboxes/${s.connectionId}`, "/", "/signin", "/onboarding", "/select-firm"];
    const queue = [...seeds];
    const seen = new Set();
    const pages = [];
    const apis = [];
    while (queue.length && seen.size < 300) {
      const path = queue.shift();
      const key = path.replace(/[?&]f=[^&]*/, "");
      if (seen.has(key)) continue;
      seen.add(key);
      if (SKIP.some((r) => r.test(path))) continue;
      if (path.startsWith("/api/") || path.startsWith("/pdf.worker")) {
        const r = await ctx.request.get(BASE + path, { maxRedirects: 0 }).catch((e) => ({ status: () => "ERR " + e.message }));
        apis.push({ path, status: r.status(), location: r.headers ? r.headers()["location"] : undefined });
        continue;
      }
      current = path;
      let status = "ERR";
      try {
        const resp = await page.goto(BASE + path, { waitUntil: "networkidle", timeout: 30000 });
        status = resp ? resp.status() : "none";
      } catch (e) { status = "ERR " + e.message.slice(0, 100); }
      const final = page.url().replace(BASE, "");
      const body = await page.locator("body").innerText().catch(() => "");
      const flags = [];
      if (/Application error|Internal Server Error|Unhandled Runtime Error|This page could not be found/i.test(body)) flags.push(body.match(/Application error[^\n]*|Internal Server Error|Unhandled Runtime Error|This page could not be found/i)[0]);
      if (/undefined|NaN|\[object Object\]/.test(body)) flags.push("text shows: " + (body.match(/.{0,40}(undefined|NaN|\[object Object\]).{0,40}/) || [""])[0].replace(/\s+/g, " "));
      pages.push({ path, status, final: final !== path ? final : undefined, flags: flags.length ? flags : undefined });
      const links = await page.$$eval("a[href]", (as) => as.map((a) => a.getAttribute("href")));
      for (const h of links) {
        if (!h || h.startsWith("http") || h.startsWith("mailto:") || h.startsWith("#")) continue;
        if (!seen.has(h.replace(/[?&]f=[^&]*/, ""))) queue.push(h);
      }
    }
    report[role] = { pages, apis, problems };
    await ctx.close();
  }
  fs.writeFileSync("qa-crawl-report.json", JSON.stringify(report, null, 1));
  for (const [role, r] of Object.entries(report)) {
    const bad = r.pages.filter((p) => p.status !== 200 || p.flags);
    console.log(`\n== ${role}: ${r.pages.length} pages, ${r.apis.length} api links, ${r.problems.length} console/page errors`);
    for (const p of bad) console.log("  page", p.status, p.path, p.final ? "→ " + p.final : "", p.flags ? JSON.stringify(p.flags) : "");
    for (const a of r.apis) if (!(a.status === 200 || a.status === 302 || a.status === 307)) console.log("  api", a.status, a.path);
    const uniq = [...new Map(r.problems.map((p) => [p.kind + p.text, p])).values()];
    for (const p of uniq.slice(0, 15)) console.log("  err", p.kind, p.url, "::", p.text);
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
