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

const DEFAULT_MAX_CHARS = 16_000;

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

function isChapterAnchor(id: string): boolean {
  // ch-<n>-<slug> (3 parts, 3rd non-numeric) is a chapter; ch-<n>-<m>-<slug> is a section.
  const parts = id.split("-");
  if (parts.length < 3 || parts[0] !== "ch" || !/^\d+$/.test(parts[1])) return false;
  return parts.length === 3 ? !/^\d+$/.test(parts[2]) : true;
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

  // First pass: collect chapter anchors and locate the requested one.
  let headingIdx = -1;
  let level = 0;
  let inFence = false;
  const chapterAnchors: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = HEADING_RE.exec(line);
    if (m && m[3]) {
      if (isChapterAnchor(m[3])) chapterAnchors.push(`${m[3]} — ${m[2]}`);
      if (anchor && m[3] === anchor) {
        headingIdx = i;
        level = m[1].length;
      }
    }
  }

  if (anchor === null || headingIdx === -1) {
    const list = chapterAnchors.slice(0, 120).map((h) => `- ${h}`).join("\n");
    return (
      `No passage${anchor ? ` for anchor "${anchor}"` : ""} in book "${slug}". ` +
      `Chapter anchors in this book:\n${list || "(none found)"}`
    );
  }

  // Second pass: from the heading to the next same-or-higher-level heading.
  inFence = false;
  let end = lines.length;
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

  const section = lines.slice(headingIdx, end).join("\n").trim();
  if (section.length <= maxChars) return section;
  return section.slice(0, maxChars) + "\n\n…(passage truncated — narrow the anchor for a tighter section)";
}