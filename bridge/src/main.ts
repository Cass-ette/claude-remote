import { loadConfig, SIGNAL_WAIT_SECONDS } from "./config.js";
import { startHttpServer } from "./server/http-server.js";

/**
 * Bridge entry point.
 *
 * SECURITY: the Bridge binds to loopback only (enforced by loadConfig).
 * It NEVER starts a Cloudflare Tunnel itself — the tunnel connector runs
 * as a separate, user-managed process per the architecture spec.
 */
async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const server = startHttpServer(config, {});
  await server.listen({ host: config.host, port: config.port });
  server.log.info({ host: config.host, port: config.port }, "bridge listening");

  const shutdown = (signal: string) => {
    server.log.info({ signal }, "shutting down");
    void server
      .close()
      .catch((err: unknown) => {
        server.log.error({ err }, "error during close");
      })
      .finally(() => {
        setTimeout(() => process.exit(0), 0).unref();
      });
    // Force-exit if graceful close exceeds SIGNAL_WAIT_SECONDS.
    setTimeout(() => process.exit(0), SIGNAL_WAIT_SECONDS * 1000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  console.error("bridge failed to start:", err);
  process.exit(1);
});
