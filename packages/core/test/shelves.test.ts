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
  ingestBook,
  type MutationOutcome,
} from "../src/index.js";
import { runMutation, runQuery } from "../src/agent/index.js";

// ingestBook delegates cataloging to the librarian agent (runMutation) and
// routing to a read-only query (runQuery). Mock both so the test exercises the
// deterministic store + shelf-resolution + orchestration, not the LLM itself.
vi.mock("../src/agent/index.js", async (importActual) => {
  const actual = await importActual();
  return { ...actual, runMutation: vi.fn(), runQuery: vi.fn() };
});

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

describe("createShelf", () => {
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

  it("scaffolds an empty conformant shelf and registers it", async () => {
    const kb = await createShelf(reg, "mycology");
    expect(reg.get("mycology")).toBe(kb);
    const report = await kb.validate();
    expect(report.conformant).toBe(true);
    expect(report.conceptCount).toBe(0);
  });

  it("rejects a name that already exists", async () => {
    await createShelf(reg, "dup");
    await expect(createShelf(reg, "dup")).rejects.toThrow(/already exists/);
  });
});

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Sample book markdown with two GFM-anchored chapters (the pdf-to-markdown output shape). */
function sampleMarkdown(title = "The Art of X"): string {
  return (
    `# ${title}\n\n` +
    `## Chapter One {#ch-1-intro}\n\nThe first chapter full text. A long passage about intro topics.\n\n` +
    `## Chapter Two {#ch-2-next}\n\nThe second chapter full text about next topics.\n`
  );
}

/**
 * A stand-in for the librarian: writes a lightweight Book hub + Chapter catalog
 * concepts (with book:// resources + read_passage pointers) into the shelf KB,
 * the way the real agent would. Returns a successful MutationOutcome.
 */
function librarianCatalog(
  slug: string
): (kb: KnowledgeBase, instruction: string) => Promise<MutationOutcome> {
  return async (kb) => {
    await kb.writeConcept(
      `/${slug}/book.md`,
      { type: "Book", title: slug, resource: `book://${slug}` },
      `# ${slug}\n\n## Chapters\n\n- [Chapter One](/${slug}/ch-1-intro.md)\n- [Chapter Two](/${slug}/ch-2-next.md)\n`,
      "ingest"
    );
    await kb.writeConcept(
      `/${slug}/ch-1-intro.md`,
      { type: "Chapter", title: "Chapter One", description: "intro summary", resource: `book://${slug}#ch-1-intro` },
      "intro summary\n\n## Full passage\n\nFetch with `read_passage(book://" + slug + "#ch-1-intro)`.\n",
      "ingest"
    );
    await kb.writeConcept(
      `/${slug}/ch-2-next.md`,
      { type: "Chapter", title: "Chapter Two", description: "next summary", resource: `book://${slug}#ch-2-next` },
      "next summary\n\n## Full passage\n\nFetch with `read_passage(book://" + slug + "#ch-2-next)`.\n",
      "ingest"
    );
    return {
      ok: true,
      result: {
        summary: `cataloged ${slug} (2 chapters)`,
        filesChanged: [`/${slug}/book.md`, `/${slug}/ch-1-intro.md`, `/${slug}/ch-2-next.md`],
        steps: 3,
        traceId: "test",
      },
    };
  };
}

describe("ingestBook (store + librarian catalog)", () => {
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
    vi.mocked(runMutation).mockReset();
    vi.mocked(runQuery).mockReset();
  });

  afterEach(async () => {
    await fs.rm(work, { recursive: true, force: true });
  });

  it("stores the markdown in the stacks once and catalogs into the supplied shelf", async () => {
    vi.mocked(runMutation).mockImplementation(librarianCatalog("the-art-of-x"));
    const result = await ingestBook(reg, libraryRoot, sampleMarkdown("The Art of X"), {
      slug: "the-art-of-x",
      shelf: "mylib",
      description: "art books",
    });
    expect(result.slug).toBe("the-art-of-x");
    expect(result.shelves).toHaveLength(1);
    expect(result.shelves[0].shelf).toBe("mylib");
    expect(result.shelves[0].created).toBe(true);

    // stacks: single copy of the book markdown
    const stacksFile = path.join(libraryRoot, "the-art-of-x", "the-art-of-x.md");
    expect(await pathExists(stacksFile)).toBe(true);
    expect(await fs.readFile(stacksFile, "utf-8")).toContain("Chapter One {#ch-1-intro}");

    // shelf catalog segment written by the librarian
    const segDir = path.join(reg.get("mylib").bundle.root, "the-art-of-x");
    const book = await fs.readFile(path.join(segDir, "book.md"), "utf-8");
    expect(book).toContain("type: Book");
    expect(book).toContain("book://the-art-of-x");
    const ch1 = await fs.readFile(path.join(segDir, "ch-1-intro.md"), "utf-8");
    expect(ch1).toContain("type: Chapter");
    expect(ch1).toContain("book://the-art-of-x#ch-1-intro");
    expect(ch1).toContain("read_passage(book://the-art-of-x#ch-1-intro)");
    // the full text is NOT in the catalog concept
    expect(ch1).not.toContain("A long passage about intro topics");
  });

  it("reuses the stacks copy when the same book is cataloged into a second shelf", async () => {
    vi.mocked(runMutation).mockImplementation(librarianCatalog("shared-book"));
    const md = sampleMarkdown("Shared Book");
    await ingestBook(reg, libraryRoot, md, { slug: "shared-book", shelf: "shelf-a" });
    const stacksFile = path.join(libraryRoot, "shared-book", "shared-book.md");
    const firstMtime = (await fs.stat(stacksFile)).mtimeMs;
    // A second ingest with DIFFERENT markdown must not overwrite the stacks copy.
    await ingestBook(reg, libraryRoot, md + "\n\n# DIFFERENT\n", { slug: "shared-book", shelf: "shelf-b" });
    expect((await fs.stat(stacksFile)).mtimeMs).toBe(firstMtime);

    // both shelves have a catalog segment; stacks has the one (unchanged) copy
    expect(await pathExists(path.join(reg.get("shelf-a").bundle.root, "shared-book", "book.md"))).toBe(true);
    expect(await pathExists(path.join(reg.get("shelf-b").bundle.root, "shared-book", "book.md"))).toBe(true);
    expect(await fs.readFile(stacksFile, "utf-8")).not.toContain("DIFFERENT");
  });

  it("routes via the librarian when no shelf is supplied", async () => {
    vi.mocked(runQuery).mockResolvedValue({ answer: "SHELVES: python", steps: 1, traceId: "test" });
    vi.mocked(runMutation).mockImplementation(librarianCatalog("py-book"));
    const result = await ingestBook(reg, libraryRoot, sampleMarkdown("Py Book"), { slug: "py-book" });
    expect(runQuery).toHaveBeenCalledWith(reg.global, expect.any(String));
    expect(result.shelves).toHaveLength(1);
    expect(result.shelves[0].shelf).toBe("python");
    expect(result.shelves[0].created).toBe(true);
    expect(runMutation).toHaveBeenCalledWith(reg.get("python"), expect.any(String));
  });

  it("routes to multiple topic shelves when the librarian returns several", async () => {
    vi.mocked(runQuery).mockResolvedValue({ answer: "SHELVES: python, security", steps: 1, traceId: "test" });
    vi.mocked(runMutation).mockImplementation(librarianCatalog("hacking-py"));
    const result = await ingestBook(reg, libraryRoot, sampleMarkdown("Hacking with Python"), {
      slug: "hacking-py",
    });
    expect(result.shelves.map((s) => s.shelf).sort()).toEqual(["python", "security"]);
    expect(runMutation).toHaveBeenCalledTimes(2);
  });

  it("skips a shelf where the book is already cataloged", async () => {
    vi.mocked(runMutation).mockImplementation(librarianCatalog("dup-book"));
    await createShelf(reg, "mylib");
    // pre-create the segment dir so the ingest skips this shelf
    await fs.mkdir(path.join(reg.get("mylib").bundle.root, "dup-book"), { recursive: true });
    const result = await ingestBook(reg, libraryRoot, sampleMarkdown("Dup Book"), {
      slug: "dup-book",
      shelf: "mylib",
    });
    expect(result.shelves[0].skipped).toMatch(/already cataloged/);
    expect(runMutation).not.toHaveBeenCalled();
  });

  it("rejects the global shelf as a target", async () => {
    await expect(
      ingestBook(reg, libraryRoot, sampleMarkdown("X"), { slug: "x", shelf: "global" })
    ).rejects.toThrow(/topic shelves, not the global shelf/);
  });

  it("derives the slug from the first H1 when none is given", async () => {
    vi.mocked(runMutation).mockImplementation(librarianCatalog("my-book"));
    const result = await ingestBook(reg, libraryRoot, sampleMarkdown("My Book"), { shelf: "mylib" });
    expect(result.slug).toBe("my-book");
    expect(result.title).toBe("My Book");
  });
});