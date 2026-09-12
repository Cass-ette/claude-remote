/**
 * Minimal dotenv-style KEY=VALUE parsing/rendering shared by the deploy
 * scripts.
 *
 * This deliberately duplicates the tiny parser in bridge/src/config.ts
 * (BRIDGE_ENV_FILE loader): the deploy scripts are plain tsx-run files
 * outside the npm workspaces and must not import bridge sources, which would
 * drag the bridge dependency graph (jose, better-sqlite3, …) into the root
 * typecheck.
 *
 * Format:
 *   - one assignment per line: KEY=VALUE (whitespace around both trimmed)
 *   - `#` comment lines and blank lines are ignored; malformed lines skipped
 *   - surrounding single or double quotes on the value are stripped
 *   - no interpolation, no multiline values — the installer writes the file,
 *     so the format stays intentionally dumb
 */

/** Parse dotenv-style text into a flat record. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = unquote(line.slice(eq + 1).trim());
    if (key !== "") out[key] = value;
  }
  return out;
}

/** Render one KEY=VALUE line, double-quoting the value. */
export function formatEnvLine(key: string, value: string): string {
  if (value.includes("\n") || value.includes("\r")) {
    throw new Error(`refusing to write multiline value for ${key}`);
  }
  return `${key}="${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function unquote(value: string): string {
  if (value.length >= 2) {
    for (const quote of ['"', "'"]) {
      if (value.startsWith(quote) && value.endsWith(quote)) {
        return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      }
    }
  }
  return value;
}
