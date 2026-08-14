import { promises as fs } from "node:fs";
import path from "node:path";
import { runMutation, runQuery, type MutationOutcome } from "../agent/index.js";
import { parseBookUri } from "../library/index.js";
import type { KnowledgeBase } from "../okf/index.js";
import { createShelf, type ShelfCreateOptions } from "./import.js";
import { ShelfNotFoundError, type ShelfRegistry } from "./registry.js";

/**
 * Book ingestion — the MCP-side "librarian" pipeline.
 *
 * pdf-to-markdown (an independent tool) produces a readable markdown file of a
 * book and nothing more. `ingestBook` receives that markdown, stores the single
 * canonical copy in the library stacks (`LIBRARY_ROOT/<slug>/<slug>.md`), then
 * hands cataloging to mycelium's built-in LLM agent: it derives the chapter
 * outline via `read_passage`, writes ≤200-char per-chapter summaries, and writes
 * lightweight Book/Chapter catalog concepts into one or more topic shelves —
 * each concept pointing at the full text through a `book://<slug>#<anchor>`
 * resource. The full text is never copied into a shelf; `read_passage` fetches a
 * passage on demand.
 *
 * A book may fit more than one topic shelf; in that case it is referenced from
 * each (one catalog segment per shelf) while the full text remains the single
 * library copy. Books go on topic shelves, never the global shelf.
 */

const SLUG_MAX = 64;

export interface IngestBookOptions {
  /** Book title. If omitted, derived from the first H1 in the markdown. */
  title?: string;
  /** Book slug (kebab-case). If omitted, derived from the title. */
  slug?: string;
  /** A single target topic shelf. If omitted, the librarian routes the book. */
  shelf?: string;
  /** Topic phrase for a newly created shelf's info.md. */
  topic?: string;
  /** Description for a newly created shelf's info.md. */
  description?: string;
}

export interface IngestShelfResult {
  /** The shelf name cataloged into. */
  shelf: string;
  /** Whether the shelf was created by this call. */
  created: boolean;
  /** Set when the book was already cataloged in this shelf (no mutation run). */
  skipped?: string;
  /** The librarian's cataloging mutation (absent when skipped). */
  outcome?: MutationOutcome;
  /** Concept count of the shelf after cataloging (best-effort). */
  conceptCount: number;
  /** Whether the shelf conforms to OKF after cataloging (best-effort). */
  conformant: boolean;
}

export interface IngestBookResult {
  slug: string;
  title: string;
  /** The single library-stacks copy of the book markdown. */
  stacksFile: string;
  /** Per-shelf cataloging results (one entry per target shelf). */
  shelves: IngestShelfResult[];
}

/** Derive a kebab-case slug from a title. */
function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX);
}

/** First H1 heading text in the markdown (stripping any trailing {#anchor}), or null. */
function firstH1(md: string): string | null {
  const m = md.match(/^#\s+(.+?)\s*(?:\{#[^}]*\})?\s*$/m);
  return m ? m[1].trim() : null;
}

/** Validate a slug against the same rules `parseBookUri` enforces. */
function validateSlug(slug: string): void {
  if (
    !slug ||
    slug === "." ||
    slug === ".." ||
    slug.includes("/") ||
    slug.includes("\\") ||
    slug.includes("\0")
  ) {
    throw new Error(`Invalid book slug: ${slug}`);
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Resolve a shelf name to its KB, creating it (with info.md) if missing. */
async function ensureShelf(
  registry: ShelfRegistry,
  name: string,
  opts: ShelfCreateOptions
): Promise<{ kb: KnowledgeBase; created: boolean }> {
  try {
    return { kb: registry.get(name), created: false };
  } catch (e) {
    if (!(e instanceof ShelfNotFoundError)) throw e;
    const kb = await createShelf(registry, name, opts);
    return { kb, created: true };
  }
}

/** Normalize a librarian-returned shelf name to a kebab-case slug. */
function normalizeShelfName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Parse `SHELVES: a, b, c` from the librarian's routing answer. */
function parseShelves(answer: string): string[] {
  const m = answer.match(/SHELVES:\s*(.+)/i);
  if (!m) return [];
  return m[1]
    .split(",")
    .map(normalizeShelfName)
    .filter((s) => s.length > 0 && s !== "global");
}

function routingInstruction(
  title: string,
  slug: string,
  shelves: { name: string; topic?: string; description?: string }[]
): string {
  const list = shelves.length
    ? shelves
        .map((s) => `- ${s.name}${s.topic ? ` — ${s.topic}` : ""}${s.description ? ` — ${s.description}` : ""}`)
        .join("\n")
    : "(no topic shelves exist yet)";
  return (
    `A new book titled "${title}" (slug "${slug}") has just been stored in the library stacks. ` +
    `Decide which topic shelf or shelves it should be cataloged on.\n\n` +
    `EXISTING TOPIC SHELVES (name — topic — description):\n${list}\n\n` +
    `Books go on topic shelves, NOT the global shelf. A book may fit more than one topic shelf. ` +
    `If the title alone is ambiguous you may call read_passage(book://${slug}) to inspect its chapter titles. ` +
    `Prefer an existing shelf when the book fits; propose a new kebab-case shelf name only if no existing shelf fits. ` +
    `Reply with exactly one line in the form: SHELVES: <name1>, <name2>`
  );
}

function catalogInstruction(title: string, slug: string): string {
  return (
    `Catalog the book "${title}" (slug "${slug}") into this shelf as a dense, cross-linked card catalog. ` +
    `The full text is already in the library stacks; do NOT paste chapter prose into concept bodies — ` +
    `summarize it and link to it via \`resource: book://${slug}#<anchor>\`.\n\n` +

    `STEP BUDGET (HARD):\n` +
    `You have at most 12 tool calls for this whole catalog. Plan accordingly:\n` +
    `  1× read_passage(book://${slug})            — discover chapters and sec-* sections\n` +
    `  1× write_concept  /${slug}/book.md          — the Book index\n` +
    `  N× write_concept  /${slug}/<anchor>.md      — one per chapter\n` +
    `  1× read_concept   /${slug}/book.md          — re-read for cross-book wiring\n` +
    `  1× patch_concept  /<other-book>/book.md     — add cross-book link(s) [best-effort]\n` +
    `  1× lint_knowledge                           — final check\n` +
    `If N + 4 > 12 (e.g. 9 chapters), DROP step 5 (cross-book patch) and lint — never drop chapter writes.\n\n` +

    `BOOK INDEX CONCEPT — write_concept path "/${slug}/book.md":\n` +
    `  frontmatter:\n` +
    `    type: "Book"\n` +
    `    title: "${title}"\n` +
    `    resource: "book://${slug}"\n` +
    `    tags: [book, <2–6 topic tags from chapter titles>]\n` +
    `    source: "<book title and/or author, if known from the markdown>"\n` +
    `    chapters: <integer N>\n` +
    `    anchors: [ch-1-${slug}, ch-2-${slug}, ...]\n` +
    `  body (target 2–5k chars):\n` +
    `    # About\n` +
    `    Two short paragraphs: what the book is, who it is for, how it is organized.\n\n` +
    `    # Chapters\n` +
    `    One bullet per chapter, absolute bundle-relative link:\n` +
    `      - [Ch 1: <title>](/${slug}/ch-1-${slug}.md) — <one-line summary>\n` +
    `    (NOT a table — bullets only)\n\n` +
    `    # Topics\n` +
    `    3–8 keyword phrases, comma-separated. Used for cross-book matching in step 5.\n\n` +
    `    # Related Concepts\n` +
    `    [/](/<this-shelf>.md) and absolute links to other Book hubs on related topics.\n\n` +

    `CHAPTER CONCEPT — for each chapter, write_concept path "/${slug}/<anchor>.md":\n` +
    `  frontmatter:\n` +
    `    type: "Chapter"\n` +
    `    title: "<chapter title>"\n` +
    `    description: 120–180 chars summarizing what it TEACHES (not what it is "about")\n` +
    `    resource: "book://${slug}#<anchor>"\n` +
    `    tags: [chapter, <2–4 subtopic tags>]\n` +
    `    book: "/${slug}/book.md"\n` +
    `    chapter_index: <1..N>\n` +
    `  body (target 3–8k chars, floor 2k — DENSE concept, not a stub):\n` +
    `    # Summary\n` +
    `    2–4 paragraphs: central thesis, 3–6 key concepts/commands/APIs, how they connect to other chapters.\n\n` +
    `    # Key Concepts\n` +
    `    5–15 bullets of every named concept/command/API the chapter covers.\n\n` +
    `    # Examples and Patterns\n` +
    `    2–5 fenced code/config snippets with one-line captions. Worked-example bullets if conceptual.\n\n` +
    `    # Pitfalls and Edge Cases\n` +
    `    1–4 bullets on gotchas, deprecations, caveats.\n\n` +
    `    # Full passage\n` +
    `    Fetch the full chapter text with \`read_passage(book://${slug}#<anchor>)\`.\n\n` +
    `    # Related Concepts\n` +
    `    Absolute bundle-relative links only:\n` +
    `      - [Book hub: ${title}](/${slug}/book.md)\n` +
    `      - [Prev chapter](/${slug}/<prev-anchor>.md)  (if not first)\n` +
    `      - [Next chapter](/${slug}/<next-anchor>.md)  (if not last)\n` +
    `      - 0–3 links to chapters in OTHER books on related topics.\n\n` +

    `STEP 5 — CROSS-BOOK WIRING (skip if over budget):\n` +
    `  (a) read_concept /${slug}/book.md — confirm your # Topics list.\n` +
    `  (b) For each OTHER Book hub whose # Topics share ≥2 keywords with this book, ` +
    `patch_concept that other book's "Related Concepts" section: - [${title}](/${slug}/book.md).\n` +
    `  (c) On each Chapter concept, link to specific chapters in sibling books covering the same ` +
    `named concept (≥2 shared items in # Key Concepts).\n\n` +

    `LINK FORMAT (critical — scanGraph only counts absolute bundle-relative links):\n` +
    `  CORRECT:  [Book hub](/${slug}/book.md)\n` +
    `  WRONG (silently ignored):  [Book hub](./book.md)\n` +
    `  Cross-book example:  [Linux networking](/linux/<some-slug>/ch-3-<some-slug>.md)\n\n` +

    `BODY LENGTH:\n` +
    `  Book index: 2–5k chars (~3k target).\n` +
    `  Chapter concept: 3–8k chars (~5k target), NEVER below 2k.\n` +
    `  If read_passage for a chapter returns > 128k chars (truncated), compose from chapter title + ` +
    `sub-section titles + your knowledge — do NOT try to re-read the full chapter.\n` +
    `  If read_passage(book://${slug}) returns no anchors, write a Book-only catalog at /${slug}/book.md ` +
    `documenting the missing structure and stop. Do NOT invent chapter anchors.\n\n` +
    `Begin with read_passage(book://${slug}). When every chapter is cataloged, summarize what you created ` +
    `(concept count, chapter count, cross-book links added).`
  );
}

/**
 * Ingest a book's markdown into the library + catalog it via the librarian.
 *
 * The deterministic part: write the received markdown to
 * `LIBRARY_ROOT/<slug>/<slug>.md` (one copy per book, reused if present). The
 * cataloging is delegated to {@link runMutation} against each target shelf KB —
 * the librarian derives the chapter outline via `read_passage` and writes
 * Book/Chapter catalog concepts. When no `shelf` is supplied, a read-only
 * {@link runQuery} against the global KB routes the book to one or more topic
 * shelves (the shelf list is embedded in the routing prompt, since the global
 * agent does not otherwise see the shelf registry).
 */
export async function ingestBook(
  registry: ShelfRegistry,
  libraryRoot: string,
  markdown: string,
  opts: IngestBookOptions = {}
): Promise<IngestBookResult> {
  const title = opts.title ?? firstH1(markdown) ?? "untitled";
  const slug = opts.slug ?? slugify(title);
  validateSlug(slug);
  // Defense in depth: parseBookUri applies the same slug rules read_passage will.
  parseBookUri(`book://${slug}`);

  if (opts.shelf === "global") {
    throw new Error("Books go on topic shelves, not the global shelf.");
  }

  // 1. Deterministic store — one copy per book, reused on every re-ingest.
  const stacksDir = path.join(path.resolve(libraryRoot), slug);
  const stacksFile = path.join(stacksDir, `${slug}.md`);
  if (!(await pathExists(stacksFile))) {
    await fs.mkdir(stacksDir, { recursive: true });
    await fs.writeFile(stacksFile, markdown, "utf-8");
  }

  // 2. Resolve target topic shelves.
  let shelfNames: string[];
  if (opts.shelf) {
    shelfNames = [normalizeShelfName(opts.shelf)];
    if (shelfNames[0].length === 0) throw new Error(`Invalid shelf name: ${opts.shelf}`);
  } else {
    const shelves = await registry.list();
    const route = await runQuery(registry.global, routingInstruction(title, slug, shelves));
    shelfNames = parseShelves(route.answer);
    if (shelfNames.length === 0) {
      throw new Error(`Librarian did not return a shelf for "${title}". Routing answer: ${route.answer}`);
    }
  }

  // 3. Catalog into each shelf — one mutation per shelf, one library copy.
  const shelfResults: IngestShelfResult[] = [];
  for (const name of shelfNames) {
    const { kb, created } = await ensureShelf(registry, name, { topic: opts.topic, description: opts.description });
    const segDir = path.join(kb.bundle.root, slug);
    if (await pathExists(segDir)) {
      shelfResults.push({ shelf: name, created, skipped: "already cataloged in this shelf", conceptCount: 0, conformant: true });
      continue;
    }
    const outcome = await runMutation(kb, catalogInstruction(title, slug));
    let conceptCount = 0;
    let conformant = false;
    try {
      const report = await kb.validate();
      conformant = report.conformant;
      conceptCount = report.conceptCount;
    } catch {
      // validate is best-effort; the mutation outcome already carries errors.
    }
    shelfResults.push({ shelf: name, created, outcome, conceptCount, conformant });
  }

  return { slug, title, stacksFile, shelves: shelfResults };
}