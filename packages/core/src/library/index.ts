import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * The library "stacks": a content store of full book markdown, separate from
 * the OKF bundles (global + shelves). One copy per book, under
 * `LIBRARY_ROOT/<book-slug>/<book-slug>.md` (+ figures/ + meta.json), shared
 * across shelves. Catalog concepts reference a passage with a portable
 * `book://<slug>#<anchor>` URI; the agent's `read_passage` tool fetches just
 * that section on demand. This is NOT an OKF bundle — no index.md/log.md.
 */

// Per-passage character cap. Sized for a modern long-context model so a whole
// chapter fits in one read; override with READ_PASSAGE_MAX_CHARS. ~128k chars
// ≈ 32k tokens, well within a 1M-token context window.
const DEFAULT_MAX_CHARS = Number(process.env.READ_PASSAGE_MAX_CHARS) || 128_000;

// A markdown heading with an optional GFM explicit ID: `## Title {#id}`
const HEADING_RE = /^(#{1,6})\s+(.*?)\s*(?:\{#([^}]+)\})?\s*$/;
const FENCE_RE = /^\s*(```|~~~)/;

/**
 * Resolve the library root: the `LIBRARY_ROOT` env var if set, otherwise a
 * `library/` dir sibling to `BUNDLE_ROOT` (mirrors `resolveShelvesRoot`).
 */
export function resolveLibraryRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.LIBRARY_ROOT) return env.LIBRARY_ROOT;
  const bundleRoot = env.BUNDLE_ROOT;
  if (!bundleRoot) throw new Error("BUNDLE_ROOT env var is required");
  return path.join(path.dirname(path.resolve(bundleRoot)), "library");
}

export interface BookUri {
  slug: string;
  anchor: string | null;
}

/** Parse `book://<slug>#<anchor>` (anchor optional). Rejects path escapes. */
export function parseBookUri(uri: string): BookUri {
  const m = /^book:\/\/([^/?#]+)(?:#(.+))?$/.exec(uri);
  if (!m) throw new Error(`Not a book:// URI: ${uri}`);
  const slug = decodeURIComponent(m[1]);
  if (!slug || slug === "." || slug === ".." || slug.includes("/") || slug.includes("\\") || slug.includes("\0")) {
    throw new Error(`Invalid book slug: ${slug}`);
  }
  return { slug, anchor: m[2] ? decodeURIComponent(m[2]) : null };
}

/** Path to a book's readable markdown in the stacks. */
export function bookFile(libraryRoot: string, slug: string): string {
  return path.join(path.resolve(libraryRoot), slug, `${slug}.md`);
}

function containsOutside(parent: string, child: string): boolean {
  const p = path.resolve(parent);
  const c = path.resolve(child);
  return !(c === p || c.startsWith(p + path.sep));
}

/** Chapter anchors use the `ch-` prefix; section anchors use `sec-`. The prefix
 * split (rather than a `ch-<n>-<m>-<slug>` section scheme) keeps chapters and
 * sections unambiguous by prefix — a chapter whose title starts with a digit
 * (e.g. "1. Python Basics" → `ch-1-1-python-basics`) is still a chapter. */
function isChapterAnchorId(id: string): boolean {
  return id.startsWith("ch-");
}
function isSectionAnchorId(id: string): boolean {
  return id.startsWith("sec-");
}
function isBookAnchorId(id: string): boolean {
  return isChapterAnchorId(id) || isSectionAnchorId(id);
}
/** The chapter index encoded in a `ch-<n>-…` or `sec-<n>-…` anchor. */
function chapterNumberOf(id: string): number | null {
  const parts = id.split("-");
  return parts.length >= 2 && /^\d+$/.test(parts[1]) ? Number(parts[1]) : null;
}

/**
 * Read one passage from a book in the stacks. Resolves `book://<slug>#<anchor>`
 * to `<libraryRoot>/<slug>/<slug>.md`, sandboxes the slug under the library
 * root, and extracts the section under the heading whose GFM `{#anchor}` matches
 * (up to the next same-or-higher-level heading). Returns the section text,
 * capped at `maxChars`. If the anchor is missing/not found, returns the book's
 * chapter-anchor list so the caller can pick a valid one.
 */
export async function readPassage(
  libraryRoot: string,
  uri: string,
  maxChars = DEFAULT_MAX_CHARS
): Promise<string> {
  const { slug, anchor } = parseBookUri(uri);
  const root = path.resolve(libraryRoot);
  const file = bookFile(root, slug);
  if (containsOutside(root, file)) throw new Error(`book slug escapes library root: ${slug}`);

  const text = await fs.readFile(file, "utf-8").catch(() => null);
  if (text === null) throw new Error(`Book not found in library: ${slug} (expected ${file})`);

  const lines = text.split("\n");

  // Pass 1: collect every anchored book heading (ch- chapters and sec- sections)
  // and locate the requested anchor.
  interface AnchoredHeading { id: string; title: string; level: number; line: number; }
  const anchored: AnchoredHeading[] = [];
  let headingIdx = -1;
  let level = 0;
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = HEADING_RE.exec(line);
    if (m && m[3] && isBookAnchorId(m[3])) {
      anchored.push({ id: m[3], title: m[2], level: m[1].length, line: i });
      if (anchor && m[3] === anchor) {
        headingIdx = i;
        level = m[1].length;
      }
    }
  }

  if (anchor === null || headingIdx === -1) {
    return formatAnchorList(slug, anchored, anchor);
  }

  // Pass 2: find the passage end.
  // - Chapter anchor (ch-): the whole chapter, from this heading to the NEXT
  //   chapter heading — so same-level section headings inside the chapter
  //   (which marker sometimes emits as H1) don't truncate it.
  // - Section anchor (sec-): the section, from this heading to the next
  //   same-or-higher-level heading.
  let end = lines.length;
  if (isChapterAnchorId(anchor)) {
    const nextChapter = anchored.find((h) => h.line > headingIdx && isChapterAnchorId(h.id));
    end = nextChapter ? nextChapter.line : lines.length;
  } else {
    inFence = false;
    for (let i = headingIdx + 1; i < lines.length; i++) {
      const line = lines[i];
      if (FENCE_RE.test(line)) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      const m = HEADING_RE.exec(line);
      if (m && m[1].length <= level) {
        end = i;
        break;
      }
    }
  }

  const section = lines.slice(headingIdx, end).join("\n").trim();
  if (section.length <= maxChars) return section;
  return section.slice(0, maxChars) + "\n\n…(passage truncated — narrow the anchor for a tighter section)";
}

/** Discovery list (chapters with their sections) returned when no anchor is
 * given or the requested anchor isn't found. Filters `sec-0-*` front-matter. */
function formatAnchorList(
  slug: string,
  anchored: { id: string; title: string; level: number; line: number }[],
  anchor: string | null
): string {
  const chapters = anchored.filter((h) => isChapterAnchorId(h.id));
  const sectionsByChapter = new Map<number, { id: string; title: string }[]>();
  for (const h of anchored) {
    if (!isSectionAnchorId(h.id)) continue;
    const n = chapterNumberOf(h.id);
    if (n === null || n === 0) continue; // sec-0 = front-matter
    const arr = sectionsByChapter.get(n) ?? [];
    arr.push({ id: h.id, title: h.title });
    sectionsByChapter.set(n, arr);
  }
  const out: string[] = [];
  for (const ch of chapters) {
    out.push(`- ${ch.id} — ${ch.title}`);
    const n = chapterNumberOf(ch.id);
    const secs = (n !== null && sectionsByChapter.get(n)) || [];
    for (const s of secs) out.push(`  - ${s.id} — ${s.title}`);
  }
  const list = out.slice(0, 400).join("\n");
  return (
    `No passage${anchor ? ` for anchor "${anchor}"` : ""} in book "${slug}". ` +
    `Chapter anchors and sections in this book:\n${list || "(none found)"}`
  );
}