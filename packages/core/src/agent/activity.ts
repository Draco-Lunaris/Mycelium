/**
 * Process-wide tracker of in-flight agent operations.
 *
 * The web UI polls `GET /api/activity` (backed by `activity.snapshot()`) to show a
 * global "agent working" badge — including runs triggered by external MCP clients
 * (`memory_query` / `memory_update`), which never go through the web UI themselves.
 *
 * Singleton is safe: the server is one process and `start`/`end` are synchronous
 * Map mutations, which the Node event loop serializes.
 */

/** One in-flight agent operation, as seen by the web UI's activity badge. */
export interface ActiveOp {
  id: number;
  kind: "query" | "mutate" | "chat";
  /** Shelf/bundle root the run is scoped to, when known. */
  shelf?: string;
  /** Short human label (the question, the instruction, or "(chat)"). */
  label?: string;
  /** Epoch milliseconds when the run started. */
  startedAt: number;
}

export interface ActivitySnapshot {
  active: ActiveOp[];
  count: number;
}

export type ActivityKind = ActiveOp["kind"];

type Listener = (snapshot: ActivitySnapshot) => void;

/** Drop active entries older than this — recovers from missed `end()` calls. */
const MAX_AGE_MS = 10 * 60 * 1000; // 10 min

export class ActivityTracker {
  private active = new Map<number, ActiveOp>();
  private nextId = 1;
  private listeners = new Set<Listener>();
  private readonly maxAgeMs: number;

  constructor(options: { maxAgeMs?: number } = {}) {
    this.maxAgeMs = options.maxAgeMs ?? MAX_AGE_MS;
  }

  /** Record the start of a run; returns the id to pass to `end()`. */
  start(kind: ActivityKind, meta: { shelf?: string; label?: string } = {}): number {
    const id = this.nextId++;
    this.active.set(id, { id, kind, shelf: meta.shelf, label: meta.label, startedAt: Date.now() });
    this.emit();
    return id;
  }

  /** Record the end of a run. No-op for an unknown id (already pruned or never started). */
  end(id: number): void {
    if (this.active.delete(id)) this.emit();
  }

  /** Current in-flight ops, after pruning any stale entries. */
  snapshot(): ActivitySnapshot {
    this.prune();
    const active = [...this.active.values()];
    return { active, count: active.length };
  }

  /** Subscribe to live changes. Unused by the polling web UI today, but cheap to keep. */
  subscribe(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** Drop active entries older than maxAgeMs. Silent (no emit) — callers poll snapshot(). */
  private prune(): void {
    const now = Date.now();
    for (const [id, op] of this.active) {
      if (now - op.startedAt > this.maxAgeMs) this.active.delete(id);
    }
  }

  private emit(): void {
    if (this.listeners.size === 0) return;
    const snapshot = { active: [...this.active.values()], count: this.active.size };
    for (const cb of this.listeners) cb(snapshot);
  }
}

/** Process-wide singleton. */
export const activity = new ActivityTracker();