import { parseDuration, runDream, type ShelfRegistry } from "@mycelium/core";

const MIN_INTERVAL_MS = 5 * 60_000;

/**
 * Background dreamer: runs a consolidation pass every DREAM_INTERVAL
 * (e.g. "6h") across the global store AND every shelf. Opt-in — unset means
 * no background token spend. The first run happens one interval after boot,
 * never at startup. A healthy store (no orphans/broken links) costs nothing.
 */
export function startDreamer(registry: ShelfRegistry): void {
  const raw = process.env.DREAM_INTERVAL;
  const interval = parseDuration(raw);
  if (!interval) {
    if (raw) console.error(`[mycelium] invalid DREAM_INTERVAL "${raw}" — dreaming disabled`);
    else console.log("[mycelium] dreaming: disabled (set DREAM_INTERVAL, e.g. 6h, to enable)");
    return;
  }
  const every = Math.max(interval, MIN_INTERVAL_MS);
  console.log(`[mycelium] dreaming: every ${raw}${every !== interval ? " (clamped to 5m minimum)" : ""}`);

  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return; // never overlap dreams
    busy = true;
    try {
      for (const kb of registry.all()) {
        const label = kb === registry.global ? "global" : kb.bundle.root;
        try {
          const report = await runDream(kb);
          if (report.ran) {
            console.log(
              `[mycelium] dream complete (${label}): ${report.filesChanged?.length ?? 0} file(s) changed — ${truncate(report.summary ?? "", 200)}`
            );
          } else {
            console.log(`[mycelium] dream skipped (${label}): ${report.reason}`);
          }
        } catch (err) {
          console.error(`[mycelium] dream failed (${label}): ${(err as Error).message}`);
        }
      }
    } finally {
      busy = false;
    }
  }, every);
  timer.unref(); // never keep the process alive just to dream
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}