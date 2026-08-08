import { tool } from "ai";
import { z } from "zod";
import type { KnowledgeBase } from "../okf/index.js";
import type { TreeNode } from "../okf/types.js";
import type { TraceRecorder } from "./trace.js";
import { recordHotDelete, recordHotWrite } from "./hot-memory.js";
import { readPassage } from "../library/index.js";

/** Bundle-relative concept path, e.g. "/tables/customers.md". */
const conceptPath = z
  .string()
  .describe('Bundle-relative path starting with "/", ending in .md');

const frontmatterSchema = z
  .object({
    type: z.string().min(1).describe("Concept kind, e.g. 'API Endpoint'. Required."),
    title: z.string().optional(),
    description: z.string().optional().describe("One-line summary"),
    resource: z.string().optional().describe("Canonical URI of the underlying asset"),
    tags: z.array(z.string()).optional(),
  })
  .passthrough()
  .describe("YAML frontmatter. Additional producer-defined keys are allowed.");

const logSummary = z
  .string()
  .describe(
    "One past-tense sentence for the update log, with bundle-relative links, e.g. 'Added [Billing API](/apis/billing-api.md).'"
  );

export function buildReadTools(kb: KnowledgeBase, trace?: TraceRecorder, libraryRoot?: string) {
  return {
    search_knowledge: tool({
      description:
        "Search the knowledge base by keywords, optionally filtered by concept type and/or tags. Returns ranked hits with paths and snippets. NOTE: matching is keyword-based, not semantic — a miss does NOT mean the knowledge is absent; it may be worded differently.",
      inputSchema: z.object({
        query: z.string().describe("Keywords to search for. May be empty when filtering by type/tags only."),
        type: z.string().optional().describe("Exact concept type filter"),
        tags: z.array(z.string()).optional().describe("Require ALL of these tags"),
      }),
      execute: async ({ query, type, tags }) => {
        const hits = await kb.search(query, { type, tags });
        trace?.record("search_knowledge", query, hits.map((h) => h.path));
        if (hits.length > 0) return hits;
        // Keyword miss ≠ knowledge absent. Put the map in the tool result so
        // the model's next step is to read plausible concepts, not give up.
        const tree = formatTree(await kb.listTree());
        return {
          hits: [],
          notice:
            "No keyword matches — but this search is literal, not semantic. The knowledge may exist under different wording. Before concluding it is absent: (1) retry with 1-2 synonyms or broader terms, (2) review the layout below and read_concept ANY concept whose type, name, or description could plausibly relate to the question.",
          bundle_layout: tree,
        };
      },
    }),
    read_concept: tool({
      description: "Read one concept document in full: frontmatter and markdown body.",
      inputSchema: z.object({ path: conceptPath }),
      execute: async ({ path }) => {
        const c = await kb.readConcept(path);
        trace?.record("read_concept", c.path, [c.path]);
        return { path: c.path, frontmatter: c.frontmatter, body: c.body };
      },
    }),
    list_directory: tool({
      description:
        "List the bundle's directory tree with concept types/titles/descriptions. Use to understand structure and decide where new concepts belong.",
      inputSchema: z.object({}),
      execute: async () => {
        trace?.record("list_directory", "", []);
        return formatTree(await kb.listTree());
      },
    }),
    lint_knowledge: tool({
      description:
        "Graph health check: orphaned concepts (nothing links to them) and broken links. Use to find what needs wiring into the graph or fixing.",
      inputSchema: z.object({}),
      execute: async () => {
        trace?.record("lint_knowledge", "", []);
        return kb.lint();
      },
    }),
    read_passage: tool({
      description:
        "Read a full passage from a book in the library stacks. A catalog `Book`/`Chapter` concept has a small summary body and a `resource` field like `book://<slug>#<anchor>` — call this with that resource to fetch the full chapter/section text on demand. Do NOT assume a chapter concept's body is the whole chapter; it is only a summary — use read_passage for the full text.",
      inputSchema: z.object({
        resource: z
          .string()
          .describe("A book://<slug>#<anchor> URI, taken from a concept's `resource` field"),
      }),
      execute: async ({ resource }) => {
        if (!libraryRoot) {
          return { resource, error: "No library configured (LIBRARY_ROOT unset); cannot read passages." };
        }
        try {
          const passage = await readPassage(libraryRoot, resource);
          trace?.record("read_passage", resource, [resource]);
          return { resource, passage };
        } catch (err) {
          return { resource, error: err instanceof Error ? err.message : String(err) };
        }
      },
    }),
  };
}

export function buildWriteTools(kb: KnowledgeBase, filesChanged: Set<string>, trace?: TraceRecorder) {
  return {
    write_concept: tool({
      description:
        "Create a new concept or fully overwrite an existing one. Frontmatter must include a non-empty 'type'. index.md and log.md maintenance is automatic — never write those.",
      inputSchema: z.object({
        path: conceptPath,
        frontmatter: frontmatterSchema,
        body: z.string().describe("Markdown body (no frontmatter block)"),
        log_summary: logSummary,
      }),
      execute: async ({ path, frontmatter, body, log_summary }) => {
        const c = await kb.writeConcept(path, frontmatter, body, log_summary);
        filesChanged.add(c.path);
        recordHotWrite(kb.bundle.root, c.path);
        trace?.record("write_concept", c.path, [c.path], true);
        return { written: c.path };
      },
    }),
    patch_concept: tool({
      description:
        "Targeted update of an existing concept: merge frontmatter keys (null deletes a key) and/or replace one top-level '# Section' body section. Prefer this over write_concept for small edits.",
      inputSchema: z.object({
        path: conceptPath,
        frontmatter: z
          .record(z.unknown())
          .optional()
          .describe("Frontmatter keys to merge; set a key to null to remove it"),
        replace_section: z
          .object({
            heading: z
              .string()
              .min(1)
              .describe("Top-level heading name, e.g. 'Schema'. Must be non-empty — to replace the whole body use replace_body instead."),
            content: z.string().describe("New content for that section"),
          })
          .optional(),
        replace_body: z
          .string()
          .optional()
          .describe("Replace the entire markdown body (frontmatter untouched). Use for restructuring; prefer replace_section for targeted edits."),
        log_summary: logSummary,
      }),
      execute: async ({ path, frontmatter, replace_section, replace_body, log_summary }) => {
        const c = await kb.patchConcept(
          path,
          {
            frontmatter,
            replaceSection: replace_section
              ? { heading: replace_section.heading, content: replace_section.content }
              : undefined,
            replaceBody: replace_body,
          },
          log_summary
        );
        filesChanged.add(c.path);
        recordHotWrite(kb.bundle.root, c.path);
        trace?.record("patch_concept", c.path, [c.path], true);
        return { patched: c.path };
      },
    }),
    delete_concept: tool({
      description:
        "Permanently delete a concept file. Prefer deprecation (tag 'deprecated' via patch_concept) unless content is wrong/harmful or deletion was explicitly requested.",
      inputSchema: z.object({
        path: conceptPath,
        log_summary: logSummary,
      }),
      execute: async ({ path, log_summary }) => {
        await kb.deleteConcept(path, log_summary);
        filesChanged.add(path);
        recordHotDelete(kb.bundle.root, path);
        trace?.record("delete_concept", path, [path], true);
        return { deleted: path };
      },
    }),
  };
}

/** Compact indented listing for prompts and the list_directory tool. */
export function formatTree(node: TreeNode, depth = 0): string {
  const lines: string[] = [];
  if (depth === 0) lines.push("/");
  for (const child of node.children ?? []) {
    const indent = "  ".repeat(depth + 1);
    if (child.kind === "directory") {
      lines.push(`${indent}${child.name}/`);
      lines.push(formatTree(child, depth + 1));
    } else if (child.kind === "concept") {
      const meta = [child.type, child.description].filter(Boolean).join(" — ");
      lines.push(`${indent}${child.name}${meta ? `  [${meta}]` : ""}`);
    }
  }
  return lines.filter(Boolean).join("\n");
}

/** Count concept nodes anywhere under `node`. */
export function countConceptsInTree(node: TreeNode): number {
  let n = 0;
  for (const child of node.children ?? []) {
    if (child.kind === "concept") n++;
    else if (child.kind === "directory") n += countConceptsInTree(child);
  }
  return n;
}

/**
 * Segment-level summary for LARGE bundles (too many concepts to list each one
 * in the system prompt): one line per top-level segment with a count, the
 * distinct types, and the first few concept titles. Root-level concepts are
 * listed individually. The agent then navigates via search/read tools instead
 * of a pre-loaded tree.
 */
export function formatTreeCompact(node: TreeNode): string {
  const lines: string[] = ["/"];
  for (const child of node.children ?? []) {
    if (child.kind === "directory") {
      const count = countConceptsInTree(child);
      const types = collectTypes(child);
      const titles = collectTitles(child).slice(0, 3).join(", ");
      const typeList = types.size ? ` (${[...types].sort().join(", ")})` : "";
      lines.push(`${child.name}/ — ${count} concept${count === 1 ? "" : "s"}${typeList}${titles ? `: ${titles}` : ""}`);
    } else if (child.kind === "concept") {
      const meta = [child.type, child.description].filter(Boolean).join(" — ");
      lines.push(`${child.name}${meta ? `  [${meta}]` : ""}`);
    }
  }
  return lines.join("\n");
}

function collectTypes(node: TreeNode, set = new Set<string>()): Set<string> {
  for (const child of node.children ?? []) {
    if (child.kind === "concept" && child.type) set.add(child.type);
    else if (child.kind === "directory") collectTypes(child, set);
  }
  return set;
}

function collectTitles(node: TreeNode, out: string[] = []): string[] {
  for (const child of node.children ?? []) {
    if (child.kind === "concept") out.push(child.title ?? child.name);
    else if (child.kind === "directory") collectTitles(child, out);
  }
  return out;
}
