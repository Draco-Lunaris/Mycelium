import { useEffect, useState } from "react";
import { fetchActivity, type ActivitySnapshot } from "../api.js";

const IDLE: ActivitySnapshot = { active: [], count: 0 };

/**
 * Polls `GET /api/activity` and returns the server's in-flight agent ops. This is
 * what makes externally-triggered runs (e.g. an MCP client's `memory_query` /
 * `memory_update`) visible in the web UI — those runs never go through the web
 * fetch layer, so the browse spinner can't see them. Fetches directly (bypassing
 * the browse in-flight store) so the 1s poll never lights the browse spinner.
 * Transient fetch errors keep the last known state so a flaky poll never flickers
 * the badge off.
 */
export function useAgentActivity(intervalMs = 1000): ActivitySnapshot {
  const [snapshot, setSnapshot] = useState<ActivitySnapshot>(IDLE);

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      fetchActivity()
        .then((s) => {
          if (!cancelled) setSnapshot(s);
        })
        .catch(() => {
          /* keep last state on transient error */
        });
    };
    tick(); // fetch immediately on mount
    const handle = setInterval(tick, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [intervalMs]);

  return snapshot;
}