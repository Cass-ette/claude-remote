import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureAdminToken, verifyAdminToken } from "../../src/admin/admin-token.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "admin-token-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("ensureAdminToken", () => {
  it("creates a 0600 file with a base64url 32-byte token on first call", () => {
    const { token, path } = ensureAdminToken(dir);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(path).toBe(join(dir, "admin-api-token"));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8").trim()).toBe(token);
  });
  it("reuses the existing token and never rotates", () => {
    const first = ensureAdminToken(dir);
    const second = ensureAdminToken(dir);
    expect(second.token).toBe(first.token);
  });
  it("fails closed when the existing file is group/world readable", () => {
    ensureAdminToken(dir);
    chmodSync(join(dir, "admin-api-token"), 0o644);
    expect(() => ensureAdminToken(dir)).toThrow(/admin-api-token/);
  });
});

describe("verifyAdminToken", () => {
  it("accepts the exact token and rejects anything else", () => {
    const { token } = ensureAdminToken(dir);
    expect(verifyAdminToken(token, token)).toBe(true);
    expect(verifyAdminToken(token, token.slice(0, -1))).toBe(false);
    expect(verifyAdminToken(token, "")).toBe(false);
    expect(verifyAdminToken(token, `${token}x`)).toBe(false);
  });
});
