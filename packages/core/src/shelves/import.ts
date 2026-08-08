import { promises as fs } from "node:fs";
import path from "node:path";
import { regenerateIndex, regenerateIndexChain } from "../okf/indexer.js";
import { appendLog } from "../okf/logger.js";
import { validateBundle } from "../okf/validate.js";
import { parseDoc, serializeDoc } from "../okf/frontmatter.js";
import type { ConceptFrontmatter, ConformanceReport } from "../okf/types.js";
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

// ── Library book import (catalog + stacks) ──────────────────────────────

/** Coerce a loosely-typed sidecar frontmatter value to a string. */
function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
/** Coerce to a string array (the sidecar's `tags` list). */
function strArray(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : undefined;
}

export interface ImportBookResult {
  slug: string;
  shelfName: string;
  chapterCount: number;
  stacksDir: string;
  report: ConformanceReport;
}

/**
 * Import a `pdf-to-markdown` book into the library **as a card catalog**:
 * store the full book text once in the stacks (`LIBRARY_ROOT/<slug>/<slug>.md`),
 * and write lightweight catalog concepts (Book hub + Chapter concepts with the
 * sidecar's ≤200-char summary, a `book://` resource, and a `read_passage`
 * pointer) into the target shelf. The full chapter text is NOT put in the
 * shelf — the agent fetches it on demand via `read_passage`.
 *
 * If the book is already in the stacks (cataloged from another shelf), the
 * stacks copy is reused (one copy per book, referenced from any shelf).
 */
export async function importBook(
  registry: ShelfRegistry,
  libraryRoot: string,
  pdfOutputDir: string,
  shelfName?: string
): Promise<ImportBookResult> {
  const src = path.resolve(pdfOutputDir);
  const slug = path.basename(src);
  if (!slug) throw new Error(`Cannot determine book slug from: ${src}`);
  const sidecarSeg = path.join(src, "kb", slug);
  if (!(await pathExists(path.join(sidecarSeg, "book.md")))) {
    throw new Error(`Not a pdf-to-markdown output (expected kb/${slug}/book.md): ${src}`);
  }

  // Locate the readable book .md (prefer meta.json#readable_book_path basename).
  const metaPath = path.join(sidecarSeg, "meta.json");
  const meta: { readable_book_path?: string } = await fs
    .readFile(metaPath, "utf-8")
    .then((t) => JSON.parse(t))
    .catch(() => ({}));
  let readableBook: string | null = null;
  if (meta.readable_book_path) {
    const cand = path.join(src, path.basename(meta.readable_book_path));
    if (await pathExists(cand)) readableBook = cand;
  }
  if (!readableBook) {
    const entries = await fs.readdir(src, { withFileTypes: true });
    const md = entries.find(
      (e) => e.isFile() && e.name.endsWith(".md") && e.name !== "log.md" && !e.name.startsWith(".")
    );
    if (md) readableBook = path.join(src, md.name);
  }
  if (!readableBook) throw new Error(`No readable book .md found in ${src}`);

  // Stacks: reuse if the book is already stored, else copy (normalized to <slug>.md).
  const stacksDir = path.join(path.resolve(libraryRoot), slug);
  if (!(await pathExists(stacksDir))) {
    await fs.mkdir(stacksDir, { recursive: true });
    await fs.copyFile(readableBook, path.join(stacksDir, `${slug}.md`));
    const figSrc = path.join(src, "figures");
    if (await pathExists(figSrc)) await fs.cp(figSrc, path.join(stacksDir, "figures"), { recursive: true });
    if (await pathExists(metaPath)) await fs.copyFile(metaPath, path.join(stacksDir, "meta.json"));
  }

  // Target shelf: reuse if it exists, else create it.
  await ensureShelvesRoot(registry);
  const name = shelfName ?? "library";
  let shelfKb: KnowledgeBase;
  try {
    shelfKb = registry.get(name);
  } catch {
    shelfKb = await createShelf(registry, name);
  }
  const segDir = path.join(shelfKb.bundle.root, slug);
  if (await pathExists(segDir)) {
    throw new Error(`Book already cataloged in shelf "${name}": ${slug}`);
  }
  await fs.mkdir(segDir, { recursive: true });

  // Read the sidecar's book hub + chapter concepts and emit lightweight catalog concepts.
  const bookDoc = parseDoc(await fs.readFile(path.join(sidecarSeg, "book.md"), "utf-8"));
  const sidecarEntries = await fs.readdir(sidecarSeg);
  const chapterFiles = sidecarEntries.filter((f) => /^ch-.*\.md$/.test(f)).sort();
  let chapterCount = 0;
  for (const cf of chapterFiles) {
    const sid = cf.replace(/\.md$/, "");
    const doc = parseDoc(await fs.readFile(path.join(sidecarSeg, cf), "utf-8"));
    // Carry the sidecar's structural links (book + prev/next); drop the full-text body.
    const related = doc.body.split(/\n## Related Concepts\n/)[1]?.trim() ?? "";
    const catFm: ConceptFrontmatter = {
      type: "Chapter",
      title: str(doc.frontmatter.title),
      description: str(doc.frontmatter.description),
      tags: strArray(doc.frontmatter.tags),
      resource: `book://${slug}#${sid}`,
      timestamp: str(doc.frontmatter.timestamp),
    };
    const desc = str(doc.frontmatter.description) ?? "";
    const catBody =
      `# ${catFm.title ?? sid}\n\n${desc}\n\n` +
      `## Full passage\n\nFetch the full chapter text with \`read_passage(book://${slug}#${sid})\`.\n\n` +
      `## Related Concepts\n\n${related}\n`;
    await fs.writeFile(path.join(segDir, `${sid}.md`), serializeDoc(catFm, catBody));
    chapterCount++;
  }

  // Book hub: reuse the sidecar hub's body (About + Chapters links resolve in the shelf);
  // rewrite the type and the resource to point at the stacks.
  const bookFm: ConceptFrontmatter = {
    type: "Book",
    title: str(bookDoc.frontmatter.title),
    description: str(bookDoc.frontmatter.description),
    tags: strArray(bookDoc.frontmatter.tags),
    resource: `book://${slug}`,
    timestamp: str(bookDoc.frontmatter.timestamp),
  };
  await fs.writeFile(path.join(segDir, "book.md"), serializeDoc(bookFm, bookDoc.body));

  // Regenerate the segment + root index.md, and append a log entry.
  await regenerateIndexChain(shelfKb.bundle, `/${slug}`);
  await appendLog(shelfKb.bundle, "Creation", `Imported book [${slug}](${slug}/) (catalog; full text in library).`);
  const report = await validateBundle(shelfKb.bundle);
  return { slug, shelfName: name, chapterCount, stacksDir, report };
}