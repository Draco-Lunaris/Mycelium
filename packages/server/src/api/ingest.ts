import express, { type Router, type Request, type Response, type NextFunction } from "express";
import multer from "multer";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ingestBook, type IngestBookResult, type IngestShelfResult, type ShelfRegistry } from "@mycelium/core";

/**
 * Web-based book ingest — the file-upload counterpart to the (removed)
 * inline-text `memory_ingest_book` MCP tool.
 *
 * A client (e.g. `curl -F file=@book.md -F shelf=kubernetes ...`) streams a
 * `.md` book file over multipart/form-data. multer writes it to a work
 * directory on the server's own disk (diskStorage — the file lands on disk, not
 * in a memory buffer); the handler then reads that staged file and hands its
 * contents to the existing `ingestBook()` core, which stores the canonical
 * library copy and catalogs the chapters onto a topic shelf. The staged file is
 * removed once processing finishes (success or failure).
 *
 * This is what makes ingest work at book scale: the bytes arrive as a file that
 * is processed from disk, never as text squeezed through a tool argument (which
 * truncates/drifts for a 728KB book).
 */
const WORK_DIR = process.env.INGEST_WORK_DIR ?? path.join(os.tmpdir(), "mycelium-ingest");
const LIMIT_MB = process.env.INGEST_LIMIT_MB ? Number(process.env.INGEST_LIMIT_MB) : 32;

await fs.mkdir(WORK_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: WORK_DIR,
    filename: (_req, _file, cb) => cb(null, `${randomUUID()}.md`),
  }),
  limits: { fileSize: LIMIT_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/\.md$/i.test(file.originalname)) cb(null, true);
    else cb(new Error("Only .md files are accepted."));
  },
});

const metadataSchema = z.object({
  title: z.string().optional(),
  slug: z.string().optional(),
  shelf: z.string().optional(),
  topic: z.string().optional(),
  description: z.string().optional(),
});

type Metadata = z.infer<typeof metadataSchema>;

interface ShelfResultBody {
  shelf: string;
  created: boolean;
  skipped?: string;
  conceptCount: number;
  conformant: boolean;
  outcome?: { ok: true; summary: string } | { ok: false; error: string };
}

interface IngestResponseBody {
  ok: true;
  slug: string;
  title: string;
  stacksFile: string;
  shelves: ShelfResultBody[];
}

type ResponseBody = { ok: false; error: string } | IngestResponseBody;

function shelfResultBody(s: IngestShelfResult): ShelfResultBody {
  const outcome = s.outcome
    ? s.outcome.ok
      ? { ok: true as const, summary: s.outcome.result.summary }
      : { ok: false as const, error: s.outcome.error }
    : undefined;
  return {
    shelf: s.shelf,
    created: s.created,
    skipped: s.skipped,
    conceptCount: s.conceptCount,
    conformant: s.conformant,
    outcome,
  };
}

function toResponseBody(result: IngestBookResult): IngestResponseBody {
  return {
    ok: true,
    slug: result.slug,
    title: result.title,
    stacksFile: result.stacksFile,
    shelves: result.shelves.map(shelfResultBody),
  };
}

/**
 * Core of the upload handler, extracted for unit testing. Takes the path of the
 * staged file on disk (multer has already written it) plus the parsed form
 * fields; reads the file, calls `ingestBook`, and returns an HTTP
 * `{status, body}` pair. Does NOT throw — all failures become 4xx/5xx bodies.
 */
export async function handleIngestBookUpload(
  registry: ShelfRegistry,
  libraryRoot: string | undefined,
  stagedFilePath: string | undefined,
  fields: unknown
): Promise<{ status: number; body: ResponseBody }> {
  if (!libraryRoot) {
    return {
      status: 503,
      body: { ok: false, error: "No library configured (LIBRARY_ROOT unset); cannot ingest books." },
    };
  }
  if (!stagedFilePath) {
    return {
      status: 400,
      body: { ok: false, error: "Missing 'file' upload field (expected a .md file under the 'file' form field)." },
    };
  }
  const parsed = metadataSchema.safeParse(fields);
  if (!parsed.success) {
    return { status: 400, body: { ok: false, error: parsed.error.issues.map((i) => i.message).join("; ") } };
  }
  const meta: Metadata = parsed.data;
  let markdown: string;
  try {
    markdown = await fs.readFile(stagedFilePath, "utf-8");
  } catch (err) {
    return {
      status: 400,
      body: { ok: false, error: `Could not read staged file: ${err instanceof Error ? err.message : String(err)}` },
    };
  }
  try {
    const result = await ingestBook(registry, libraryRoot, markdown, meta);
    return { status: 200, body: toResponseBody(result) };
  } catch (err) {
    return {
      status: 400,
      body: { ok: false, error: `Book ingest failed: ${err instanceof Error ? err.message : String(err)}` },
    };
  }
}

export function ingestRouter(registry: ShelfRegistry, libraryRoot?: string): Router {
  const router = express.Router();

  router.post("/ingest-book", upload.single("file"), async (req, res) => {
    const stagedPath = req.file?.path;
    try {
      const { status, body } = await handleIngestBookUpload(registry, libraryRoot, stagedPath, req.body);
      res.status(status).json(body);
    } finally {
      if (stagedPath) await fs.rm(stagedPath, { force: true }).catch(() => {});
    }
  });

  // Multipart rejections from `upload.single` (non-.md via fileFilter, oversize
  // via MulterError) arrive as errors — surface them as 400 instead of the
  // Express default 500.
  router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ ok: false, error: message });
  });

  return router;
}