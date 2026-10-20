/**
 * Eigenständiger Worker-Prozess (nur mit echtem Postgres sinnvoll):
 *   DATABASE_URL=postgres://... RUN_WORKER_IN_APP=false npm run worker
 */
import "dotenv/config";

async function main() {
  // "server-only" ist außerhalb von Next ein No-op-Stub.
  const { startWorker } = await import("../src/lib/jobs/worker");
  startWorker();
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
