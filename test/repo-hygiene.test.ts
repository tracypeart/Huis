import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

/**
 * Guards against ignore rules (meant for evidence data) hiding source code:
 * every file under the source folders must be committable.
 */
describe("repository hygiene", () => {
  it("no source file is hidden by .gitignore", () => {
    let inGit = true;
    try { execFileSync("git", ["rev-parse", "--git-dir"], { stdio: "ignore" }); } catch { inGit = false; }
    if (!inGit) return;
    const out = execFileSync("git", ["ls-files", "--others", "--ignored", "--exclude-standard", "--", "app", "src", "lib", "db", "test", "docs", ".github"], { encoding: "utf8" });
    expect(out.trim().split("\n").filter(Boolean)).toEqual([]);
  });
});
