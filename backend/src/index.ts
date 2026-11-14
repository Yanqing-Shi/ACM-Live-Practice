import { getDefaultExecutor } from "./sandbox";
import { createIcpcServer } from "./server";

const PORT = Number(process.env.PORT || 3001);
const trustProxy = /^(1|true|yes)$/i.test(process.env.TRUST_PROXY || "");
const corsAllowedOrigins = (process.env.CORS_ALLOWED_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

// Decide how submitted code will run before accepting any connection, so a
// production server misconfigured to run it unsandboxed fails to start.
try {
  const executor = getDefaultExecutor();

  console.log(
    `[RUNNER] mode=${executor.mode} sandboxed=${executor.sandboxed}` +
      (executor.sandboxed ? "" : " (development only: no isolation)")
  );
} catch (error) {
  console.error(
    "[STARTUP FAILED]",
    error instanceof Error ? error.message : error
  );
  process.exit(1);
}

const icpc = createIcpcServer({
  adminToken: process.env.ADMIN_TOKEN || undefined,
  trustProxy,
  corsAllowedOrigins,
});

function shutdown(signal: NodeJS.Signals): void {
  console.log(`[${signal}] Saving rooms before shutdown`);
  icpc.saveAllRooms();
  process.exit(0);
}

icpc
  .listen(PORT)
  .then((port) => {
    console.log(`Server is running on port ${port}`);
  })
  .catch((error) => {
    console.error("[STARTUP FAILED]", error);
    process.exit(1);
  });

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("beforeExit", icpc.saveAllRooms);
