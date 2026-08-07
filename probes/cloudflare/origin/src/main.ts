// Process entry point for `npm start`. Reads runtime config from env,
// boots the loopback origin, and emits the resolved port + evidence path
// on stdout so the gate runner (run-real-gate.ts) can pick them up.
//
// stdout protocol (one line each, flushed synchronously):
//   ORIGIN_PORT=<port>
//   ORIGIN_EVIDENCE_FILE=<abs path>
//
// All server logs go to stderr so stdout remains machine-parseable.

import { resolve } from "node:path";
import { createOriginServer } from "./server.js";
import { defaultJwksFetcher } from "./access-verifier.js";

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    process.stderr.write(`origin: missing required env ${name}\n`);
    process.exit(2);
  }
  return v;
}

async function main(): Promise<void> {
  const teamDomain = requiredEnv("CF_ACCESS_TEAM_DOMAIN");
  const audience = requiredEnv("CF_ACCESS_AUD");
  const expectedSubject = process.env.CF_EXPECTED_SUBJECT || undefined;
  const evidenceFile = resolve(
    process.env.CF_ORIGIN_EVIDENCE_FILE || "./cloudflare-origin-evidence.json"
  );
  const bindHost = process.env.CF_ORIGIN_BIND || "127.0.0.1";
  const bindPort = parseInt(process.env.CF_ORIGIN_PORT || "0", 10) || 0;

  if (bindHost !== "127.0.0.1" && bindHost !== "localhost") {
    process.stderr.write(`origin: refusing non-loopback bind host: ${bindHost}\n`);
    process.exit(2);
  }

  const handle = await createOriginServer(
    {
      bindHost,
      bindPort,
      teamDomain,
      audience,
      evidenceFile,
      ...(expectedSubject !== undefined ? { expectedSubject } : {})
    },
    defaultJwksFetcher
  );

  // Emit the handshake lines synchronously and flush so the parent can
  // parse them before any further server output.
  process.stdout.write(`ORIGIN_PORT=${handle.port}\n`);
  process.stdout.write(`ORIGIN_EVIDENCE_FILE=${evidenceFile}\n`);

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    try {
      await handle.close();
    } catch {
      // ignore
    }
    // Exit code 128 + signal convention; 130 for SIGINT, 143 for SIGTERM.
    process.exit(128 + (signal === "SIGINT" ? 2 : 15));
  };

  process.on("SIGINT", (sig) => void shutdown(sig));
  process.on("SIGTERM", (sig) => void shutdown(sig));
}

void main().catch((err: unknown) => {
  process.stderr.write(`origin: ${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});
