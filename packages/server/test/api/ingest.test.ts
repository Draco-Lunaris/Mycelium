import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ShelfRegistry, ingestBook, type IngestBookResult } from "@mycelium/core";
import { handleIngestBookUpload } from "../../src/api/ingest.js";

// The handler delegates to ingestBook; mock it so the test exercises the
// server-side wiring (field parsing, libRoot guard, staged-file read, response
// formatting) — not the already-tested core orchestration or the LLM.
vi.mock("@mycelium/core", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return { ...actual, ingestBook: vi.fn() };
});

function tmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "mycelium-ingest-api-"));
}

async function makeBundle(root: string): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(
    path.join(root, "index.md"),
    '---\nokf_version: "0.1"\n---\n\n# Knowledge Base\n\n## Memory Segments\n'
  );
  await fs.writeFile(path.join(root, "log.md"), "# Directory Update Log\n");
}

const SAMPLE_MD =
  "# The Art of X\n\n## Chapter One {#ch-1-intro}\n\nIntro text.\n\n## Chapter Two {#ch-2-next}\n\nNext text.\n";

function fakeResult(libraryRoot: string): IngestBookResult {
  return {
    slug: "the-art-of-x",
    title: "The Art of X",
    stacksFile: path.join(libraryRoot, "the-art-of-x", "the-art-of-x.md"),
    shelves: [
      {
        shelf: "mylib",
        created: true,
        conceptCount: 3,
        conformant: true,
        outcome: {
          ok: true,
          result: {
            summary: "cataloged 2 chapters",
            filesChanged: ["/the-art-of-x/book.md"],
            steps: 3,
            traceId: "test",
          },
        },
      },
    ],
  };
}

type ErrorBody = { ok: false; error: string };

describe("POST /api/ingest-book — handleIngestBookUpload", () => {
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
    vi.mocked(ingestBook).mockReset();
  });

  afterEach(async () => {
    await fs.rm(work, { recursive: true, force: true });
  });

  async function stageSample(): Promise<string> {
    const staged = path.join(work, "staged.md");
    await fs.writeFile(staged, SAMPLE_MD, "utf-8");
    return staged;
  }

  it("reads the staged file and calls ingestBook with its contents + metadata", async () => {
    vi.mocked(ingestBook).mockResolvedValue(fakeResult(libraryRoot));
    const staged = await stageSample();
    const { status, body } = await handleIngestBookUpload(reg, libraryRoot, staged, {
      shelf: "mylib",
      description: "art books",
    });
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, slug: "the-art-of-x", title: "The Art of X" });
    expect(vi.mocked(ingestBook)).toHaveBeenCalledWith(
      reg,
      libraryRoot,
      SAMPLE_MD,
      expect.objectContaining({ shelf: "mylib", description: "art books" })
    );
    const shelves = (body as { shelves: { outcome?: { summary?: string } }[] }).shelves;
    expect(shelves[0].outcome?.summary).toBe("cataloged 2 chapters");
  });

  it("returns 400 when no file was staged (missing 'file' field)", async () => {
    const { status, body } = await handleIngestBookUpload(reg, libraryRoot, undefined, { shelf: "mylib" });
    expect(status).toBe(400);
    expect((body as ErrorBody).error).toMatch(/Missing 'file'/);
    expect(vi.mocked(ingestBook)).not.toHaveBeenCalled();
  });

  it("returns 503 when no library is configured", async () => {
    const staged = await stageSample();
    const { status, body } = await handleIngestBookUpload(reg, undefined, staged, { shelf: "mylib" });
    expect(status).toBe(503);
    expect((body as ErrorBody).error).toMatch(/No library configured/);
    expect(vi.mocked(ingestBook)).not.toHaveBeenCalled();
  });

  it("returns 400 when metadata fields fail validation", async () => {
    const staged = await stageSample();
    const { status, body } = await handleIngestBookUpload(reg, libraryRoot, staged, { shelf: 123 });
    expect(status).toBe(400);
    expect((body as ErrorBody).error).toBeTruthy();
    expect(vi.mocked(ingestBook)).not.toHaveBeenCalled();
  });

  it("returns 400 when ingestBook throws (e.g. shelf='global')", async () => {
    vi.mocked(ingestBook).mockRejectedValue(new Error("Books go on topic shelves, not the global shelf."));
    const staged = await stageSample();
    const { status, body } = await handleIngestBookUpload(reg, libraryRoot, staged, { shelf: "global" });
    expect(status).toBe(400);
    expect((body as ErrorBody).error).toMatch(/Book ingest failed/);
    expect((body as ErrorBody).error).toMatch(/global shelf/);
  });
});