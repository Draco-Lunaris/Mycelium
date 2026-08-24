import { promises as fs } from "node:fs";
import path from "node:path";
import type { KnowledgeBase } from "../okf/index.js";
import type { ShelfRegistry } from "./registry.js";

/**
 * Shelf scaffolding. `createShelf` scaffolds an empty topic shelf (root
 * index.md + log.md + info.md) and registers it. Book ingestion — receiving
 * markdown, storing the single library copy, and cataloging it via the
 * librarian agent — lives in `./ingest.ts`.
 */

const ROOT_INDEX = `---\nokf_version: "0.1"\n---\n\n# Knowledge Base\n\n## Memory Segments\n`;
const ROOT_LOG = `# Directory Update Log\n`;

/** Options for a new shelf's info.md (the shelf's own description). */
export interface ShelfCreateOptions {
  topic?: string;
  description?: string;
  /**
   * Shelf kind. `"book"` marks a book-only shelf (cataloged by the librarian
   * during ingest); the write guard redirects client writes away from it to
   * the global store. Omit for a general/scratch shelf.
   */
  kind?: string;
}

/**
 * Render a shelf's `info.md` — a reserved metadata file (not an OKF concept)
 * holding the shelf's topic + description (+ optional kind). The session seed
 * reads it so the agent can route to the shelf by what it covers, not just its
 * name; the registry reads `kind` to decide whether the shelf is book-only.
 */
function shelfInfoContent(name: string, opts: ShelfCreateOptions = {}): string {
  const topic = opts.topic || name;
  const description = opts.description || "";
  const kindLine = opts.kind ? `kind: ${JSON.stringify(opts.kind)}\n` : "";
  return (
    "---\n" +
    `name: ${JSON.stringify(name)}\n` +
    `topic: ${JSON.stringify(topic)}\n` +
    `description: ${JSON.stringify(description)}\n` +
    kindLine +
    "---\n\n" +
    `# ${name}\n\n` +
    (description ||
      "Describe what this shelf covers; the agent routes to it by this description.")
  );
}

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

/** Scaffold an empty shelf (root index.md + log.md + info.md) and register it. */
export async function createShelf(
  registry: ShelfRegistry,
  name: string,
  opts: ShelfCreateOptions = {}
): Promise<KnowledgeBase> {
  await ensureShelvesRoot(registry);
  const root = path.join(registry.shelvesRoot, name);
  if (await pathExists(path.join(root, "index.md"))) {
    throw new Error(`Shelf already exists: ${name} (${root})`);
  }
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, "index.md"), ROOT_INDEX);
  await fs.writeFile(path.join(root, "log.md"), ROOT_LOG);
  await fs.writeFile(path.join(root, "info.md"), shelfInfoContent(name, opts));
  const kb = registry.newKb(root);
  registry.register(name, kb);
  return kb;
}