import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { microsoftAuthorizeUrl, pkceChallenge, verifyMicrosoftIdToken } from "../src/auth/microsoft";
import { seal, unseal } from "../src/auth/tokens";

const CLIENT_ID = "834e42f3-7b16-4473-bb23-e9990b483139";
const TENANT = "6e13c098-b656-43cc-97b7-8a0000000000";
const OID = "11111111-2222-3333-4444-555555555555";

let privateKey: CryptoKey;
let keys: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: "test-key", alg: "RS256" };
  keys = createLocalJWKSet({ keys: [jwk] });
});

async function token(over: Record<string, unknown> = {}, opts: { iss?: string; aud?: string; exp?: string } = {}) {
  return new SignJWT({ tid: TENANT, oid: OID, nonce: "n-123", name: "Jane Smith", preferred_username: "jane@firm.example", ...over })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(opts.iss ?? `https://login.microsoftonline.com/${TENANT}/v2.0`)
    .setAudience(opts.aud ?? CLIENT_ID)
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? "1h")
    .sign(privateKey);
}

describe("Microsoft ID token verification", () => {
  it("accepts a valid token and keys the identity on tenant + object id, not email", async () => {
    const id = await verifyMicrosoftIdToken(await token(), { clientId: CLIENT_ID, nonce: "n-123", keys });
    expect(id).toEqual({
      provider: "microsoft", subject: `${TENANT}:${OID}`, name: "Jane Smith",
      email: "jane@firm.example", tenantId: TENANT,
    });
  });

  it("rejects a token issued for a different app", async () => {
    await expect(verifyMicrosoftIdToken(await token({}, { aud: "someone-else" }), { clientId: CLIENT_ID, nonce: "n-123", keys }))
      .rejects.toThrow();
  });

  it("rejects a replayed token (wrong nonce)", async () => {
    await expect(verifyMicrosoftIdToken(await token(), { clientId: CLIENT_ID, nonce: "other", keys }))
      .rejects.toThrow(/nonce/);
  });

  it("rejects an issuer that does not match the token's tenant", async () => {
    const evil = await token({}, { iss: "https://login.microsoftonline.com/99999999-9999-9999-9999-999999999999/v2.0" });
    await expect(verifyMicrosoftIdToken(evil, { clientId: CLIENT_ID, nonce: "n-123", keys })).rejects.toThrow();
  });

  it("rejects expired tokens", async () => {
    const old = await token({}, { exp: "-10m" });
    await expect(verifyMicrosoftIdToken(old, { clientId: CLIENT_ID, nonce: "n-123", keys })).rejects.toThrow();
  });

  it("rejects tokens signed with a different key", async () => {
    const other = await generateKeyPair("RS256");
    const forged = await new SignJWT({ tid: TENANT, oid: OID, nonce: "n-123" })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(`https://login.microsoftonline.com/${TENANT}/v2.0`).setAudience(CLIENT_ID)
      .setIssuedAt().setExpirationTime("1h").sign(other.privateKey);
    await expect(verifyMicrosoftIdToken(forged, { clientId: CLIENT_ID, nonce: "n-123", keys })).rejects.toThrow();
  });

  it("builds an authorization URL with PKCE and state", () => {
    const url = new URL(microsoftAuthorizeUrl({
      clientId: CLIENT_ID, redirectUri: "http://localhost:3000/api/auth/callback/microsoft",
      state: "s", nonce: "n", verifier: "v".repeat(43),
    }));
    expect(url.origin).toBe("https://login.microsoftonline.com");
    expect(url.searchParams.get("code_challenge")).toBe(pkceChallenge("v".repeat(43)));
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("s");
    expect(url.searchParams.get("scope")).not.toMatch(/Mail/);
  });
});

describe("encrypted session cookies", () => {
  const key = new Uint8Array(32).fill(7);

  it("round-trips and cannot be reused for a different purpose", async () => {
    const sealed = await seal({ firmId: "f", userId: "u" }, key, "session", 60);
    expect(await unseal(sealed, key, "session")).toMatchObject({ firmId: "f", userId: "u" });
    expect(await unseal(sealed, key, "pending")).toBeNull();
  });

  it("rejects tampering, wrong keys and expiry", async () => {
    const sealed = await seal({ firmId: "f" }, key, "session", 60);
    const tampered = sealed.slice(0, -4) + (sealed.endsWith("AAAA") ? "BBBB" : "AAAA");
    expect(await unseal(tampered, key, "session")).toBeNull();
    expect(await unseal(sealed, new Uint8Array(32).fill(9), "session")).toBeNull();
    const expired = await seal({ firmId: "f" }, key, "session", -10);
    expect(await unseal(expired, key, "session")).toBeNull();
  });

  it("is not readable by the browser (encrypted, not just signed)", async () => {
    const sealed = await seal({ firmId: "secret-firm-id" }, key, "session", 60);
    const decoded = sealed.split(".").map((p) => Buffer.from(p, "base64url").toString("latin1")).join("");
    expect(decoded).not.toContain("secret-firm-id");
  });
});
