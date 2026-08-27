// Test-only child for the lease-setup-failure orphan regression.
//
// Logs its own pid to argv[2] and then stays alive until killed. It
// deliberately never speaks the stream-json contract: the failure path under
// test never reaches awaitInit — the factory kills the child while the lease
// wrapper is still failing to build its FIFO.

import { writeFileSync } from "node:fs";

const pidLog = process.argv[2];
if (pidLog) {
  writeFileSync(pidLog, `${process.pid}\n`, "utf8");
}
setInterval(() => {}, 60_000);
