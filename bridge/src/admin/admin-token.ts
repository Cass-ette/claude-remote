import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** File name of the admin API bearer token inside BRIDGE_DATA_DIR (mode 0600). */
export const ADMIN_TOKEN_FILENAME = "admin-api-token";

/**
 * Load the admin API bearer token, creating it on first boot. Never rotates:
 * the menu-bar app reads this file, and rotating on restart would lock it out.
 * Fails closed when an existing file is readable by group/others.
 */
export function ensureAdminToken(dataDir: string): { token: string; path: string } {
  const path = join(dataDir, ADMIN_TOKEN_FILENAME);
  try {
    const raw = readFileSync(path, "utf8").trim();
    const mode = statSync(path).mode;
    if ((mode & 0o077) !== 0) {
      throw new Error(
        `${path} must be mode 0600 (got 0${(mode & 0o777).toString(8)}); refusing to serve the admin API with a leaked token. Delete the file to force a fresh one.`,
      );
    }
    if (raw === "") throw new Error(`${path} is empty; delete it to force a fresh token.`);
    return { token: raw, path };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const token = randomBytes(32).toString("base64url");
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  return { token, path };
}

/** Constant-time bearer comparison; length mismatch is a plain false. */
export function verifyAdminToken(expected: string, presented: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(presented, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
