import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ShelfRegistry, ingestBook, type IngestBookResult } from "@mycelium/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../../src/mcp/server.js";

// The handler delegates to ingestBook; mock it so the test exercises the
// server-side wiring (arg parsing, libRoot guard, response formatting) — not the
// already-tested core orchestration or the LLM.
vi.mock("@mycelium/core", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return { ...actual, ingestBook: vi.fn() };
});

function tmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "mycelium-ingest-"));
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

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
  return content?.find((c) => c.type === "text")?.text ?? "";
}

async function withClient(server: McpServer, run: (client: Client) => Promise<void>): Promise<void> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
  // Connect both concurrently — awaiting the client's initialize before the
  // server is connected deadlocks (the response can't come back).
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

describe("memory_ingest_book MCP tool", () => {
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

  it("calls ingestBook with the parsed args and returns a formatted summary", async () => {
    vi.mocked(ingestBook).mockResolvedValue(fakeResult(libraryRoot));
    const server = await buildMcpServer(reg, libraryRoot);
    await withClient(server, async (client) => {
      const res = await client.callTool({
        name: "memory_ingest_book",
        arguments: { markdown: SAMPLE_MD, shelf: "mylib", description: "art books" },
      });
      expect(res.isError).toBeFalsy();
      const text = textOf(res);
      expect(text).toContain('Ingested book "the-art-of-x"');
      expect(text).toContain("Stacks:");
      expect(text).toContain('shelf "mylib"');
      expect(text).toContain("created");
      expect(text).toContain("cataloged 2 chapters");
    });
    expect(vi.mocked(ingestBook)).toHaveBeenCalledWith(
      reg,
      libraryRoot,
      SAMPLE_MD,
      expect.objectContaining({ shelf: "mylib", description: "art books" })
    );
  });

  it("returns an error when no library is configured", async () => {
    const server = await buildMcpServer(reg, "");
    await withClient(server, async (client) => {
      const res = await client.callTool({
        name: "memory_ingest_book",
        arguments: { markdown: SAMPLE_MD, shelf: "mylib" },
      });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain("No library configured");
    });
    expect(vi.mocked(ingestBook)).not.toHaveBeenCalled();
  });
});