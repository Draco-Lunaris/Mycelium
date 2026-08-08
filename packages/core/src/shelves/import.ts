import { promises as fs } from "node:fs";
import path from "node:path";
import { regenerateIndex } from "../okf/indexer.js";
import { appendLog } from "../okf/logger.js";
import { validateBundle } from "../okf/validate.js";
import type { ConformanceReport } from "../okf/types.js";
import type { KnowledgeBase } from "../okf/index.js";
import type { ShelfRegistry } from "./registry.js";

/**
 * Book/shelf ingestion. The pdf-to-markdown skill emits a structurally
 * identical OKF bundle at `<book-slug>/kb/` (root index.md + log.md + a
 * per-book segment of book.md + ch-N chapter concepts). So importing is
 * mostly copy + register + validate, reusing the deterministic OKF layer
 * (regenerateIndex / appendLog) rather than hand-merging.
 */

const ROOT_INDEX = `---\nokf_version: "0.1"\n---\n\n# Knowledge Base\n\n## Memory Segments\n`;
const ROOT_LOG = `# Directory Update Log\n`;

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function ensureShelvesRoot(registry: ShelfRegistry): Promise<void> {
  await fs.mkdir(registry.shelvesRoot, { recursive: true });
}

/** Default shelf name: `<book-slug>/kb` → `<book-slug>`; otherwise the dir basename. */
function defaultShelfName(kbDir: string): string {
  const base = path.basename(path.resolve(kbDir));
  if (base === "kb") return path.basename(path.dirname(path.resolve(kbDir)));
  return base;
}

/** Scaffold an empty shelf (root index.md + log.md) and register it. */
export async function createShelf(registry: ShelfRegistry, name: string): Promise<KnowledgeBase> {
  await ensureShelvesRoot(registry);
  const root = path.join(registry.shelvesRoot, name);
  if (await pathExists(path.join(root, "index.md"))) {
    throw new Error(`Shelf already exists: ${name} (${root})`);
  }
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, "index.md"), ROOT_INDEX);
  await fs.writeFile(path.join(root, "log.md"), ROOT_LOG);
  const kb = registry.newKb(root);
  registry.register(name, kb);
  return kb;
}

export interface ImportShelfResult {
  kb: KnowledgeBase;
  name: string;
  report: ConformanceReport;
}

/**
 * Make a new shelf whose root is a complete OKF bundle (e.g. a pdf-to-markdown
 * `<book-slug>/kb/` dir). Copies the bundle into SHELVES_ROOT/<name>, registers
 * it, and validates conformance. New concept types like `Reference` (chapters)
 * are allowed — OKF `type` is an open string.
 */
export async function importShelf(
  registry: ShelfRegistry,
  kbDir: string,
  name?: string
): Promise<ImportShelfResult> {
  const src = path.resolve(kbDir);
  if (!(await pathExists(path.join(src, "index.md")))) {
    throw new Error(`Source is not an OKF bundle (no index.md): ${src}`);
  }
  await ensureShelvesRoot(registry);
  const shelfName = name ?? defaultShelfName(src);
  const root = path.join(registry.shelvesRoot, shelfName);
  if (await pathExists(path.join(root, "index.md"))) {
    throw new Error(
      `Shelf already exists: ${shelfName} — use import-book to add a book to an existing shelf`
    );
  }
  await fs.cp(src, root, { recursive: true });
  const kb = registry.newKb(root);
  registry.register(shelfName, kb);
  const report = await validateBundle(kb.bundle);
  return { kb, name: shelfName, report };
}

/**
 * Add a single book segment (a `<book-slug>/` subdirectory of a pdf-to-markdown
 * `kb/` bundle) into an existing shelf. Copies the segment into the shelf root
 * (links are absolute-from-bundle-root so they stay valid), regenerates the
 * shelf's root index.md, and appends a log entry.
 */
export async function importBookIntoShelf(
  registry: ShelfRegistry,
  shelf: string,
  bookSegmentDir: string
): Promise<KnowledgeBase> {
  const shelfKb = registry.get(shelf); // throws ShelfNotFoundError if missing
  const src = path.resolve(bookSegmentDir);
  if (!(await pathExists(path.join(src, "index.md")))) {
    throw new Error(`Source is not a book segment (no index.md): ${src}`);
  }
  const segName = path.basename(src);
  const dest = path.join(shelfKb.bundle.root, segName);
  if (await pathExists(dest)) {
    throw new Error(`Segment already exists in shelf "${shelf}": ${segName}`);
  }
  await fs.cp(src, dest, { recursive: true });
  await regenerateIndex(shelfKb.bundle, "/");
  await appendLog(shelfKb.bundle, "Creation", `Imported book segment [${segName}](${segName}/).`);
  return shelfKb;
}