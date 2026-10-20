import "server-only";
import { claimNext, complete, enqueue, fail } from "./queue";
import { handlers } from "./handlers";

/**
 * Worker-Schleife: holt fällige Jobs, führt Handler aus, plant Retries.
 * Läuft entweder im Next-Prozess (instrumentation.ts) oder als eigener Prozess
 * (`npm run worker`). Singleton über globalThis, damit HMR keine Duplikate startet.
 */

type State = { running: boolean; stop?: () => void };
const g = globalThis as unknown as { __socialhub_worker?: State };

const CONCURRENCY = 2;
const POLL_MS = 3000;
const TICK_MS = 60_000;

export function startWorker(): void {
  if (g.__socialhub_worker?.running) return;
  const state: State = { running: true };
  g.__socialhub_worker = state;
  let active = 0;
  let lastTick = 0;
  let stopped = false;

  const loop = async () => {
    while (!stopped) {
      try {
        if (Date.now() - lastTick > TICK_MS) {
          lastTick = Date.now();
          await enqueue("schedule.tick", {}, { uniqueKey: "schedule:tick", maxAttempts: 1 });
        }
        let claimedAny = false;
        while (active < CONCURRENCY) {
          const job = await claimNext();
          if (!job) break;
          claimedAny = true;
          active++;
          void (async () => {
            const handler = handlers[job.type];
            try {
              if (!handler) throw new Error(`Kein Handler für Job-Typ ${job.type}`);
              const result = await handler(job);
              await complete(job, result);
            } catch (err) {
              const retry = (err as { retry?: boolean }).retry;
              console.error(`[worker] Job ${job.type} (${job.id}) fehlgeschlagen:`, (err as Error).message);
              await fail(job, err, { retry: retry ?? true });
            } finally {
              active--;
            }
          })();
        }
        await sleep(claimedAny ? 200 : POLL_MS);
      } catch (err) {
        console.error("[worker] Schleifenfehler:", err);
        await sleep(POLL_MS);
      }
    }
    state.running = false;
  };
  state.stop = () => {
    stopped = true;
  };
  console.log("[worker] gestartet");
  void loop();
}

export function stopWorker(): void {
  g.__socialhub_worker?.stop?.();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
