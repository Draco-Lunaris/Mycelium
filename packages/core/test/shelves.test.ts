import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  KnowledgeBase,
  ShelfRegistry,
  ShelfNotFoundError,
  resolveShelvesRoot,
  bundleFingerprint,
  clearHotMemory,
  clearQueryCache,
  hotLookup,
  recordHotWrite,
  recordHotQuery,
} from "../src/index.js";

function tmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "mycelium-shelves-"));
}

async function makeBundle(root: string): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(
    path.join(root, "index.md"),
    '---\nokf_version: "0.1"\n---\n\n# Knowledge Base\n\n## Memory Segments\n'
  );
  await fs.writeFile(path.join(root, "log.md"), "# Directory Update Log\n");
}

describe("ShelfRegistry", () => {
  let globalRoot: string;
  let shelvesRoot: string;
  let reg: ShelfRegistry;

  beforeEach(async () => {
    globalRoot = await tmp();
    shelvesRoot = await tmp();
    await makeBundle(globalRoot);
    reg = new ShelfRegistry(globalRoot, { shelvesRoot });
  });

  afterEach(async () => {
    await fs.rm(globalRoot, { recursive: true, force: true });
    await fs.rm(shelvesRoot, { recursive: true, force: true });
  });

  it("get(undefined) / get('global') returns the global store", () => {
    expect(reg.get()).toBe(reg.global);
    expect(reg.get("global")).toBe(reg.global);
  });

  it("throws ShelfNotFoundError for an unknown shelf", () => {
    expect(() => reg.get("nope")).toThrow(ShelfNotFoundError);
  });

  it("discovers shelf subdirectories containing index.md and skips non-bundles / dot-dirs", async () => {
    const a = path.join(shelvesRoot, "mycology");
    const b = path.join(shelvesRoot, "coding");
    await makeBundle(a);
    await makeBundle(b);
    await fs.mkdir(path.join(shelvesRoot, "not-a-bundle"), { recursive: true }); // no index.md
    await fs.mkdir(path.join(shelvesRoot, ".hidden"), { recursive: true });
    await fs.writeFile(path.join(shelvesRoot, ".hidden", "index.md"), "x");

    const names = await reg.discover();
    expect(names.sort()).toEqual(["coding", "mycology"]);
    expect(reg.get("mycology").bundle.root).toBe(path.resolve(a));
  });

  it("treats a missing shelvesRoot as no shelves (not an error)", async () => {
    reg = new ShelfRegistry(globalRoot, { shelvesRoot: path.join(shelvesRoot, "does-not-exist") });
    expect(await reg.discover()).toEqual([]);
  });

  it("list() reports concept counts per shelf", async () => {
    const a = path.join(shelvesRoot, "mycology");
    await makeBundle(a);
    await reg.discover();
    await reg.get("mycology").writeConcept("/facts/x.md", { type: "Fact", title: "X" }, "body", "add");
    const list = await reg.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: "mycology", conceptCount: 1 });
  });
});

describe("resolveShelvesRoot", () => {
  it("defaults to a 'shelves' dir sibling to BUNDLE_ROOT", () => {
    const root = resolveShelvesRoot({ BUNDLE_ROOT: "/data/global" });
    expect(root).toBe(path.join(path.dirname(path.resolve("/data/global")), "shelves"));
  });

  it("honors SHELVES_ROOT when set", () => {
    expect(resolveShelvesRoot({ BUNDLE_ROOT: "/data/global", SHELVES_ROOT: "/custom/shelves" })).toBe(
      "/custom/shelves"
    );
  });
});

describe("shelves keep their caches independent (keyed by bundle root)", () => {
  let rootA: string;
  let rootB: string;
  let kbA: KnowledgeBase;
  let kbB: KnowledgeBase;

  beforeEach(async () => {
    rootA = await tmp();
    rootB = await tmp();
    await makeBundle(rootA);
    await makeBundle(rootB);
    kbA = new KnowledgeBase(rootA);
    kbB = new KnowledgeBase(rootB);
    clearHotMemory();
    clearQueryCache();
  });

  afterEach(async () => {
    await fs.rm(rootA, { recursive: true, force: true });
    await fs.rm(rootB, { recursive: true, force: true });
  });

  it("a write to one bundle does not purge another's hot Q&A", async () => {
    await kbA.writeConcept("/facts/a.md", { type: "Fact", title: "A" }, "alpha", "add");
    recordHotWrite(kbA.bundle.root, "/facts/a.md");
    recordHotQuery(kbB.bundle.root, "q", "answer-for-B");

    // A subsequent write to A must only invalidate A's hot state, not B's Q&A.
    await kbA.writeConcept("/facts/a2.md", { type: "Fact", title: "A2" }, "alpha2", "add");
    recordHotWrite(kbA.bundle.root, "/facts/a2.md");

    const generate = vi.fn(async () => "answer-for-B (recalled)");
    const answer = await hotLookup(kbB, "q", {}, generate);
    expect(answer).toContain("answer-for-B");
  });

  it("bundleFingerprint differs for identical content at different roots", async () => {
    await kbA.writeConcept("/facts/same.md", { type: "Fact", title: "Same" }, "identical body", "add");
    await kbB.writeConcept("/facts/same.md", { type: "Fact", title: "Same" }, "identical body", "add");
    const fa = await bundleFingerprint(kbA);
    const fb = await bundleFingerprint(kbB);
    expect(fa).not.toBe(fb);
  });
});