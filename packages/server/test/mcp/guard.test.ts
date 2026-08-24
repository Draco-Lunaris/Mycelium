import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ShelfRegistry, createShelf } from "@mycelium/core";
import { resolveWritableKb } from "../../src/mcp/server.js";

/**
 * The write guard: client writes (memory_add / memory_update) aimed at a
 * book-only shelf are redirected to the global store. resolveWritableKb is the
 * decision function; we exercise it against a real ShelfRegistry on temp dirs
 * so the kind-marker + Book-type-fallback paths in isBookShelf are covered.
 */
function tmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "mycelium-guard-"));
}

async function makeBundle(root: string): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(
    path.join(root, "index.md"),
    '---\nokf_version: "0.1"\n---\n\n# Knowledge Base\n\n## Memory Segments\n'
  );
  await fs.writeFile(path.join(root, "log.md"), "# Directory Update Log\n");
}

describe("resolveWritableKb (write guard)", () => {
  let globalRoot: string;
  let shelvesRoot: string;
  let reg: ShelfRegistry;

  beforeEach(async () => {
    globalRoot = await tmp();
    shelvesRoot = await tmp();
    await makeBundle(globalRoot);
    reg = new ShelfRegistry(globalRoot, { shelvesRoot });
    await reg.discover();
  });

  afterEach(async () => {
    await fs.rm(globalRoot, { recursive: true, force: true });
    await fs.rm(shelvesRoot, { recursive: true, force: true });
  });

  it("targets the global store when no shelf is given (no redirect)", async () => {
    const r = await resolveWritableKb(reg);
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.kb).toBe(reg.global);
    expect(r.redirectedFrom).toBeUndefined();
  });

  it("targets the global store for shelf='global' (no redirect)", async () => {
    const r = await resolveWritableKb(reg, "global");
    if ("error" in r) throw new Error("unexpected error");
    expect(r.kb).toBe(reg.global);
    expect(r.redirectedFrom).toBeUndefined();
  });

  it("targets a non-book shelf directly (no redirect)", async () => {
    await createShelf(reg, "scratch");
    const r = await resolveWritableKb(reg, "scratch");
    if ("error" in r) throw new Error("unexpected error");
    expect(r.kb).toBe(reg.get("scratch"));
    expect(r.redirectedFrom).toBeUndefined();
  });

  it("redirects a write aimed at a kind:book shelf to the global store", async () => {
    await createShelf(reg, "lib", { kind: "book" });
    const r = await resolveWritableKb(reg, "lib");
    if ("error" in r) throw new Error("unexpected error");
    expect(r.kb).toBe(reg.global);
    expect(r.redirectedFrom).toBe("lib");
  });

  it("redirects an unmarked shelf that holds a Book concept (safety-net fallback)", async () => {
    await createShelf(reg, "unmarked");
    await reg.get("unmarked").writeConcept("/someslug/book.md", { type: "Book", title: "Some" }, "body", "add");
    const r = await resolveWritableKb(reg, "unmarked");
    if ("error" in r) throw new Error("unexpected error");
    expect(r.kb).toBe(reg.global);
    expect(r.redirectedFrom).toBe("unmarked");
  });

  it("returns an error for an unknown shelf", async () => {
    const r = await resolveWritableKb(reg, "nope");
    expect("error" in r).toBe(true);
    if (!("error" in r)) return;
    expect(r.error).toMatch(/nope/);
  });
});