import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ActivityTracker } from "../src/agent/activity.js";

describe("ActivityTracker", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("start/end reports active ops with their metadata", () => {
    const t = new ActivityTracker();
    const id = t.start("query", { shelf: "/bundle", label: "what is x?" });
    expect(id).toBeTypeOf("number");

    const s = t.snapshot();
    expect(s.count).toBe(1);
    expect(s.active[0]).toMatchObject({ kind: "query", shelf: "/bundle", label: "what is x?" });
    expect(s.active[0].startedAt).toBeTypeOf("number");

    t.end(id);
    expect(t.snapshot().count).toBe(0);
  });

  it("end is a no-op for an unknown id", () => {
    const t = new ActivityTracker();
    expect(() => t.end(999)).not.toThrow();
    expect(t.snapshot().count).toBe(0);
  });

  it("tracks multiple concurrent ops independently", () => {
    const t = new ActivityTracker();
    const a = t.start("query");
    const b = t.start("mutate", { label: "fix x" });
    expect(t.snapshot().count).toBe(2);

    t.end(a);
    const mid = t.snapshot();
    expect(mid.count).toBe(1);
    expect(mid.active[0].id).toBe(b);

    t.end(b);
    expect(t.snapshot().count).toBe(0);
  });

  it("hands out unique, incrementing ids", () => {
    const t = new ActivityTracker();
    const ids = new Set([t.start("query"), t.start("mutate"), t.start("chat")]);
    expect(ids.size).toBe(3);
  });

  it("prunes entries older than maxAgeMs on snapshot", () => {
    const t = new ActivityTracker({ maxAgeMs: 1000 });
    t.start("chat");
    expect(t.snapshot().count).toBe(1);

    vi.advanceTimersByTime(1001);
    expect(t.snapshot().count).toBe(0); // pruned as stale
  });

  it("keeps entries younger than maxAgeMs", () => {
    const t = new ActivityTracker({ maxAgeMs: 1000 });
    t.start("query");
    vi.advanceTimersByTime(999);
    expect(t.snapshot().count).toBe(1);
  });

  it("notifies subscribers on start/end and stops after unsubscribe", () => {
    const t = new ActivityTracker();
    const counts: number[] = [];
    const unsub = t.subscribe((s) => counts.push(s.count));

    t.start("query"); // -> 1
    t.start("mutate"); // -> 2
    t.end(1); // -> 1
    expect(counts).toEqual([1, 2, 1]);

    unsub();
    t.end(2);
    expect(counts).toEqual([1, 2, 1]); // no further notifications
  });
});