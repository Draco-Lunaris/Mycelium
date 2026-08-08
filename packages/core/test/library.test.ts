import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseBookUri, readPassage, resolveLibraryRoot, bookFile } from "../src/library/index.js";

function tmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "mycelium-library-"));
}

describe("parseBookUri", () => {
  it("parses slug + anchor", () => {
    expect(parseBookUri("book://the-art-of-x#ch-3-the-mechanism")).toEqual({
      slug: "the-art-of-x",
      anchor: "ch-3-the-mechanism",
    });
  });
  it("parses a book URI with no anchor", () => {
    expect(parseBookUri("book://the-art-of-x")).toEqual({ slug: "the-art-of-x", anchor: null });
  });
  it("rejects a non-book URI", () => {
    expect(() => parseBookUri("file:///x/y.md#a")).toThrow(/Not a book/);
    expect(() => parseBookUri("https://example.com/x")).toThrow(/Not a book/);
  });
  it("rejects path-escape slugs", () => {
    expect(() => parseBookUri("book://..#a")).toThrow(/Invalid book slug/);
    // `a/b` can't match the slug grammar (no `/` allowed) → rejected as not a book URI.
    expect(() => parseBookUri("book://a/b#a")).toThrow();
    expect(() => parseBookUri("book://.#a")).toThrow(/Invalid book slug/);
  });
});

describe("resolveLibraryRoot", () => {
  it("honors LIBRARY_ROOT when set", () => {
    expect(resolveLibraryRoot({ BUNDLE_ROOT: "/data/global", LIBRARY_ROOT: "/custom/lib" })).toBe("/custom/lib");
  });
  it("defaults to a library/ dir sibling of BUNDLE_ROOT", () => {
    expect(resolveLibraryRoot({ BUNDLE_ROOT: "/data/global" })).toBe(
      path.join(path.dirname(path.resolve("/data/global")), "library")
    );
  });
});

describe("readPassage", () => {
  let root: string;
  const bookMd = `# The Art of X

## Table of Contents {#toc}

- [Intro](#ch-1-intro)

## Introduction {#ch-1-intro}

This is the intro paragraph. It has detail.

### A subsection {#ch-1-1-detail}

More detail here.

## Next Chapter {#ch-2-next}

Next chapter body that should NOT be included.
`;

  afterEach(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  async function setup(): Promise<string> {
    root = await tmp();
    const slug = "the-art-of-x";
    await fs.mkdir(path.join(root, slug), { recursive: true });
    await fs.writeFile(bookFile(root, slug), bookMd, "utf-8");
    return root;
  }

  it("extracts the chapter section up to the next same-level heading", async () => {
    const r = await setup();
    const passage = await readPassage(r, "book://the-art-of-x#ch-1-intro");
    expect(passage).toContain("## Introduction {#ch-1-intro}");
    expect(passage).toContain("This is the intro paragraph.");
    expect(passage).toContain("### A subsection {#ch-1-1-detail}");
    expect(passage).toContain("More detail here.");
    // The next chapter must NOT bleed in.
    expect(passage).not.toContain("Next chapter body");
  });

  it("returns the chapter-anchor list when the anchor is not found", async () => {
    const r = await setup();
    const passage = await readPassage(r, "book://the-art-of-x#nope");
    expect(passage).toContain("No passage");
    expect(passage).toContain("ch-1-intro");
    expect(passage).toContain("ch-2-next");
  });

  it("returns the chapter-anchor list when no anchor is given", async () => {
    const r = await setup();
    const passage = await readPassage(r, "book://the-art-of-x");
    expect(passage).toContain("Chapter anchors");
    expect(passage).toContain("ch-1-intro");
  });

  it("throws when the book is not in the library", async () => {
    const r = await setup();
    await expect(readPassage(r, "book://missing-book#ch-1")).rejects.toThrow(/Book not found/);
  });

  it("rejects a slug that would escape the library root", async () => {
    const r = await setup();
    await expect(readPassage(r, "book://..#a")).rejects.toThrow();
  });
});