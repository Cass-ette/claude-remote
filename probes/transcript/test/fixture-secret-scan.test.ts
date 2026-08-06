// Secret / PII leak scan for fixture files.
//
// Every fixture must contain ONLY clearly-fake markers (sk-fake-..., /Users/fakeuser/,
// @example.test, ...). Any real-looking secret pattern or a path that looks like
// a real user's home directory must fail this test.

import { describe, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const FIXTURES_DIR = resolve(here, "fixtures");

const PATTERNS: Array<{ name: string; re: RegExp }> = [
  // Real-looking Anthropic API key (sk- followed by 20+ alphanumeric).
  // Our fixtures use sk-fake-... which still matches the prefix, so we
  // require the suffix to NOT start with the literal "fake".
  {
    name: "anthropic-api-key-non-fake",
    re: /sk-(?!fake)[A-Za-z0-9]{20,}/
  },
  // Bearer token (non-fake)
  {
    name: "bearer-token-non-fake",
    re: /Bearer\s+(?!fake)[A-Za-z0-9._-]{10,}/
  },
  // AWS access key id
  { name: "aws-access-key", re: /AKIA[0-9A-Z]{16}/ },
  // Real-looking home directory: /Users/<name>/ where <name> is not "fakeuser".
  // The character class excludes "fakeuser" by demanding it NOT be the literal.
  {
    name: "real-home-directory",
    re: /\/Users\/(?!fakeuser\/)[A-Za-z0-9._-]+\//
  },
  // Email addresses (non-example domain)
  {
    name: "real-email",
    re: /[A-Za-z0-9._%+-]+@(?!example\.)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/
  },
  // Slack token
  { name: "slack-token", re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  // Generic high-entropy hex/base64 secret-looking strings of >=40 chars
  // that follow the word "secret", "token", "key", "password", "api_key".
  {
    name: "generic-secret-literal",
    re: /(?:secret|token|api[_-]?key|password)\s*[:=]\s*["']?(?!fake)[A-Za-z0-9+/=_-]{40,}["']?/i
  }
];

describe("fixture secret scan", () => {
  let files: string[] = [];
  it("fixture directory exists and is non-empty", async () => {
    files = (await readdir(FIXTURES_DIR)).filter((f) => f.endsWith(".jsonl"));
    expect(files.length).toBeGreaterThanOrEqual(5);
  });

  it("no fixture contains a real-looking API key, token, AWS key, home path, or email", async () => {
    // Re-read in case the previous test hasn't populated yet.
    files = (await readdir(FIXTURES_DIR)).filter((f) => f.endsWith(".jsonl"));
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
      const full = resolve(FIXTURES_DIR, name);
      const text = await readFile(full, "utf8");
      for (const { name: pname, re } of PATTERNS) {
        const m = re.exec(text);
        expect(
          m === null,
          `${name}: pattern "${pname}" matched "${m?.[0] ?? ""}"`
        ).toBe(true);
      }
    }
  });

  it("no fixture leaks any byte string from this repository's real source paths", async () => {
    // Guard against copy-pasting real transcript content. Real transcripts
    // would necessarily contain things like "Anthropic" with a real key
    // structure or a real home path; the previous test catches most of that,
    // but we also assert the fixtures do NOT contain the literal strings
    // ".claude/projects/" or "$HOME/.claude" since those would indicate
    // a real config-dir layout.
    files = (await readdir(FIXTURES_DIR)).filter((f) => f.endsWith(".jsonl"));
    for (const name of files) {
      const full = resolve(FIXTURES_DIR, name);
      const text = await readFile(full, "utf8");
      expect(text.includes(".claude/projects/"), `${name}: leaked .claude/projects/`).toBe(false);
      expect(text.includes("$HOME/.claude"), `${name}: leaked $HOME/.claude`).toBe(false);
    }
  });
});
