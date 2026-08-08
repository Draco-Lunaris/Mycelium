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
  createShelf,
  importShelf,
  importBookIntoShelf,
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

/** Build a pdf-to-markdown-style kb sidecar (root index + log + one book segment). */
async function makeBookKb(kbRoot: string, slug: string): Promise<void> {
  const seg = path.join(kbRoot, slug);
  await fs.mkdir(seg, { recursive: true });
  await fs.writeFile(
    path.join(kbRoot, "index.md"),
    `---\nokf_version: "0.1"\n---\n\n# Knowledge Base\n\n## Memory Segments\n\n* [${slug}](${slug}/) - 2 concepts (Reference, Project)\n`
  );
  await fs.writeFile(path.join(kbRoot, "log.md"), "# Directory Update Log\n");
  await fs.writeFile(path.join(seg, "index.md"), `# ${slug}\n\n* [Book](book.md) - hub\n* [Chapter 1](ch-1.md) - intro\n`);
  await fs.writeFile(
    path.join(seg, "book.md"),
    `---\ntype: Project\ntitle: "${slug} (Book)"\nresource: "file:///tmp/${slug}/${slug}.md"\ntimestamp: '2026-08-07T12:00:00.000Z'\n---\n# ${slug}\n\n## Chapters\n\n- [Introduction](/${slug}/ch-1.md) — intro.\n`
  );
  await fs.writeFile(
    path.join(seg, "ch-1.md"),
    `---\ntype: Reference\ntitle: "${slug} — Chapter 1"\nresource: "file:///tmp/${slug}/${slug}.md#ch-1"\ntimestamp: '2026-08-07T12:00:00.000Z'\n---\n# Introduction\n\nThe opening.\n\n## Related Concepts\n\n- [${slug} (Book)](/${slug}/book.md)\n`
  );
}

describe("shelf import pipeline", () => {
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

  it("createShelf scaffolds an empty conformant shelf and registers it", async () => {
    const kb = await createShelf(reg, "mycology");
    expect(reg.get("mycology")).toBe(kb);
    const report = await kb.validate();
    expect(report.conformant).toBe(true);
    expect(report.conceptCount).toBe(0);
  });

  it("createShelf rejects a name that already exists", async () => {
    await createShelf(reg, "dup");
    await expect(createShelf(reg, "dup")).rejects.toThrow(/already exists/);
  });

  it("importShelf copies a kb bundle into a new shelf and validates (Reference type ok)", async () => {
    const srcRoot = await tmp();
    const kbDir = path.join(srcRoot, "kb");
    await makeBookKb(kbDir, "the-art-of-x");
    const { name, report } = await importShelf(reg, kbDir, "art");
    expect(name).toBe("art");
    expect(report.conformant).toBe(true);
    expect(report.conceptCount).toBe(2);
    expect(reg.get("art").bundle.root).toBe(path.join(shelvesRoot, "art"));
    await fs.rm(srcRoot, { recursive: true, force: true });
  });

  it("importShelf defaults the name to the book slug for a <slug>/kb dir", async () => {
    const bookRoot = await tmp();
    const kbDir = path.join(bookRoot, "the-art-of-x", "kb");
    await makeBookKb(kbDir, "the-art-of-x");
    const { name } = await importShelf(reg, kbDir);
    expect(name).toBe("the-art-of-x");
    await fs.rm(bookRoot, { recursive: true, force: true });
  });

  it("importShelf rejects a source without index.md", async () => {
    const bad = await tmp(); // empty dir, no index.md
    await expect(importShelf(reg, bad, "bad")).rejects.toThrow(/not an OKF bundle/);
    await fs.rm(bad, { recursive: true, force: true });
  });

  it("importBookIntoShelf copies a segment into an existing shelf and updates its index/log", async () => {
    const bookRoot = await tmp();
    const kbDir = path.join(bookRoot, "the-art-of-x", "kb");
    await makeBookKb(kbDir, "the-art-of-x");
    await createShelf(reg, "library");
    await importBookIntoShelf(reg, "library", path.join(kbDir, "the-art-of-x"));

    const shelfKb = reg.get("library");
    const tree = await shelfKb.listTree();
    expect(countConceptsInTree(tree)).toBe(2);
    const rootIndex = await fs.readFile(path.join(shelfKb.bundle.root, "index.md"), "utf8");
    expect(rootIndex).toContain("the-art-of-x");
    const log = await shelfKb.readLog();
    expect(log.some((e) => e.summary.includes("the-art-of-x"))).toBe(true);
    await fs.rm(bookRoot, { recursive: true, force: true });
  });

  it("importBookIntoShelf rejects a missing shelf", async () => {
    const bookRoot = await tmp();
    const kbDir = path.join(bookRoot, "b", "kb");
    await makeBookKb(kbDir, "b");
    await expect(importBookIntoShelf(reg, "nope", path.join(kbDir, "b"))).rejects.toThrow(ShelfNotFoundError);
    await fs.rm(bookRoot, { recursive: true, force: true });
  });
});

function countConceptsInTree(node: { children?: { kind: string; children?: unknown[] }[] }): number {
  let n = 0;
  for (const child of node.children ?? []) {
    if (child.kind === "concept") n++;
    else if (child.kind === "directory") n += countConceptsInTree(child as { children?: { kind: string }[] });
  }
  return n;
}