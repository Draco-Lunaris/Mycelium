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
  importBook,
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

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Build a pdf-to-markdown-style output dir: <slug>/<slug>.md + kb/<slug>/{book.md, ch-*.md, meta.json}. */
async function makePdfOutput(workDir: string, slug: string): Promise<string> {
  const out = path.join(workDir, slug);
  const seg = path.join(out, "kb", slug);
  await fs.mkdir(seg, { recursive: true });
  await fs.writeFile(
    path.join(out, `${slug}.md`),
    `# ${slug} Book\n\n## Chapter One {#ch-1-intro}\n\nThe first chapter full text. A long passage about intro topics.\n\n## Chapter Two {#ch-2-next}\n\nThe second chapter full text about next topics.\n`
  );
  await fs.writeFile(
    path.join(seg, "meta.json"),
    JSON.stringify({
      readable_book_path: path.join(out, `${slug}.md`),
      chapter_count: 2,
      source_pdf: `/tmp/${slug}.pdf`,
      page_count: 100,
      converted_at: "2026-08-08T00:00:00Z",
    })
  );
  await fs.writeFile(
    path.join(seg, "ch-1-intro.md"),
    `---\ntype: Reference\ntitle: "Chapter 1: Intro"\ndescription: "The first chapter full text."\ntags:\n  - book:${slug}\n  - chapter\nresource: "file://${path.join(out, slug + ".md")}#ch-1-intro"\ntimestamp: '2026-08-08T00:00:00.000Z'\n---\n# Chapter 1: Intro\n\nThe first chapter full text. A long passage about intro topics.\n\n## Related Concepts\n\n- [${slug} (Book)](/${slug}/book.md) — the book this chapter belongs to\n- [Chapter 2](/${slug}/ch-2-next.md) — next chapter\n`
  );
  await fs.writeFile(
    path.join(seg, "ch-2-next.md"),
    `---\ntype: Reference\ntitle: "Chapter 2: Next"\ndescription: "The second chapter full text."\ntags:\n  - book:${slug}\n  - chapter\nresource: "file://${path.join(out, slug + ".md")}#ch-2-next"\ntimestamp: '2026-08-08T00:00:00.000Z'\n---\n# Chapter 2: Next\n\nThe second chapter full text about next topics.\n\n## Related Concepts\n\n- [${slug} (Book)](/${slug}/book.md) — the book this chapter belongs to\n- [Chapter 1](/${slug}/ch-1-intro.md) — previous chapter\n`
  );
  await fs.writeFile(
    path.join(seg, "book.md"),
    `---\ntype: Project\ntitle: "${slug} (Book)"\ndescription: "${slug}, by Jane Doe — 100 pages."\ntags:\n  - book:${slug}\n  - book\nresource: "file://${path.join(out, slug + ".md")}"\ntimestamp: '2026-08-08T00:00:00.000Z'\n---\n# ${slug} (Book)\n\n## About\n\n**Title:** ${slug}\n**Author:** Jane Doe\n\n## Chapters\n\n- [Chapter 1: Intro](/${slug}/ch-1-intro.md) — The first chapter full text.\n- [Chapter 2: Next](/${slug}/ch-2-next.md) — The second chapter full text.\n`
  );
  await fs.writeFile(
    path.join(out, "kb", "index.md"),
    `---\nokf_version: "0.1"\n---\n\n# Knowledge Base\n\n## Memory Segments\n\n* [${slug}](${slug}/) - 3 concepts\n`
  );
  await fs.writeFile(path.join(out, "kb", "log.md"), `# Directory Update Log\n\n## 2026-08-08\n\n* **Creation**: ${slug}\n`);
  return out;
}

describe("importBook (catalog + stacks)", () => {
  let globalRoot: string;
  let shelvesRoot: string;
  let libraryRoot: string;
  let work: string;
  let reg: ShelfRegistry;

  beforeEach(async () => {
    work = await tmp();
    globalRoot = path.join(work, "global");
    shelvesRoot = path.join(work, "shelves");
    libraryRoot = path.join(work, "library");
    await makeBundle(globalRoot);
    reg = new ShelfRegistry(globalRoot, { shelvesRoot });
    await reg.discover();
  });

  afterEach(async () => {
    await fs.rm(work, { recursive: true, force: true });
  });

  it("stores the full book in the stacks and writes a lightweight catalog in the shelf", async () => {
    const out = await makePdfOutput(work, "the-art-of-x");
    const result = await importBook(reg, libraryRoot, out, "mylib");
    expect(result.slug).toBe("the-art-of-x");
    expect(result.shelfName).toBe("mylib");
    expect(result.chapterCount).toBe(2);
    expect(result.report.conformant).toBe(true);

    // stacks: full book + meta.json stored once
    expect(await pathExists(path.join(libraryRoot, "the-art-of-x", "the-art-of-x.md"))).toBe(true);
    expect(await pathExists(path.join(libraryRoot, "the-art-of-x", "meta.json"))).toBe(true);

    // shelf catalog segment
    const segDir = path.join(reg.get("mylib").bundle.root, "the-art-of-x");
    expect(await pathExists(path.join(segDir, "book.md"))).toBe(true);
    expect(await pathExists(path.join(segDir, "ch-1-intro.md"))).toBe(true);

    // catalog chapter is small, has book:// resource + read_passage pointer, NOT the full text
    const ch1 = await fs.readFile(path.join(segDir, "ch-1-intro.md"), "utf-8");
    expect(ch1).toContain("type: Chapter");
    expect(ch1).toContain("book://the-art-of-x#ch-1-intro");
    expect(ch1).toContain("read_passage(book://the-art-of-x#ch-1-intro)");
    expect(ch1).not.toContain("A long passage about intro topics");

    // book hub points at the stacks
    const book = await fs.readFile(path.join(segDir, "book.md"), "utf-8");
    expect(book).toContain("type: Book");
    expect(book).toContain("book://the-art-of-x");
  });

  it("reuses the stacks copy when the same book is cataloged into a second shelf", async () => {
    const out = await makePdfOutput(work, "shared-book");
    await importBook(reg, libraryRoot, out, "shelf-a");
    const { shelfName } = await importBook(reg, libraryRoot, out, "shelf-b");
    expect(shelfName).toBe("shelf-b");
    // both shelves have the catalog segment; stacks has one copy
    expect(await pathExists(path.join(reg.get("shelf-a").bundle.root, "shared-book", "book.md"))).toBe(true);
    expect(await pathExists(path.join(reg.get("shelf-b").bundle.root, "shared-book", "book.md"))).toBe(true);
    expect(await pathExists(path.join(libraryRoot, "shared-book", "shared-book.md"))).toBe(true);
  });
});