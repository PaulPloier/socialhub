/**
 * Startet den Job-Worker im Next-Prozess, wenn kein separater Worker läuft
 * (Pflicht bei PGlite, weil nur ein Prozess auf die Datenbank zugreifen darf).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const { workerRunsInApp } = await import("./lib/env");
  if (!workerRunsInApp()) return;
  const { startWorker } = await import("./lib/jobs/worker");
  startWorker();
}
