#!/usr/bin/env tsx
/**
 * Agent + shelf CLI.
 *   BUNDLE_ROOT=../sample-bundle pnpm agent:query  "What do we know about billing?"
 *   BUNDLE_ROOT=../sample-bundle pnpm agent:mutate "Add a concept about the users table"
 *   BUNDLE_ROOT=../sample-bundle pnpm shelf create mycology
 *   BUNDLE_ROOT=../sample-bundle pnpm shelf import <book-slug>/kb --name mycology
 *   BUNDLE_ROOT=../sample-bundle pnpm shelf import-book <book-slug>/kb/<book-slug> --into mycology
 *   BUNDLE_ROOT=../sample-bundle pnpm shelf list
 *   BUNDLE_ROOT=../sample-bundle pnpm book import <pdf-to-markdown-output>/<book-slug> --into library
 */
import {
  KnowledgeBase,
  ShelfRegistry,
  resolveShelvesRoot,
  resolveLibraryRoot,
  runQuery,
  runMutation,
  createShelf,
  importShelf,
  importBookIntoShelf,
  importBook,
} from "../index.js";

const [mode, ...rest] = process.argv.slice(2);

function usage(): never {
  console.error(`Usage:
  BUNDLE_ROOT=<dir> tsx cli.ts query|mutate "<text>"
  BUNDLE_ROOT=<dir> [SHELVES_ROOT=<dir>] tsx cli.ts shelf create <name>
  BUNDLE_ROOT=<dir> [SHELVES_ROOT=<dir>] tsx cli.ts shelf import <kb-dir> [--name <name>]
  BUNDLE_ROOT=<dir> [SHELVES_ROOT=<dir>] tsx cli.ts shelf import-book <segment-dir> --into <shelf>
  BUNDLE_ROOT=<dir> [SHELVES_ROOT=<dir>] tsx cli.ts shelf list
  BUNDLE_ROOT=<dir> [SHELVES_ROOT=<dir>] [LIBRARY_ROOT=<dir>] tsx cli.ts book import <pdf-output-dir> [--into <shelf>]`);
  process.exit(1);
}

if (mode === "shelf") {
  await runShelf(rest);
} else if (mode === "book") {
  await runBook(rest);
} else if (mode === "query" || mode === "mutate") {
  const input = rest.join(" ").trim();
  const bundleRoot = process.env.BUNDLE_ROOT;
  if (!bundleRoot || !input) usage();
  const kb = new KnowledgeBase(bundleRoot, {
    gitAutocommit: process.env.GIT_AUTOCOMMIT === "true",
  });
  if (mode === "query") {
    const { answer, steps } = await runQuery(kb, input);
    console.log(answer);
    console.error(`\n[${steps} steps]`);
  } else {
    const outcome = await runMutation(kb, input);
    if (outcome.ok) {
      console.log(outcome.result.summary);
      console.error(
        `\n[${outcome.result.steps} steps] files changed: ${outcome.result.filesChanged.join(", ") || "none"}`
      );
    } else {
      console.error(`Mutation failed: ${outcome.error}`);
      process.exit(1);
    }
  }
} else {
  usage();
}

async function runShelf(args: string[]): Promise<void> {
  const bundleRoot = process.env.BUNDLE_ROOT;
  if (!bundleRoot) {
    console.error("BUNDLE_ROOT env var is required");
    process.exit(1);
  }
  const registry = new ShelfRegistry(bundleRoot, {
    shelvesRoot: resolveShelvesRoot(),
    gitAutocommit: process.env.GIT_AUTOCOMMIT === "true",
  });
  await registry.discover();

  const [sub, ...rest] = args;
  const flag = (name: string): string | undefined => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };

  try {
    if (sub === "create") {
      const name = rest[0];
      if (!name) usage();
      const kb = await createShelf(registry, name);
      console.log(`Created shelf "${name}" at ${kb.bundle.root}`);
    } else if (sub === "import") {
      const kbDir = rest[0];
      if (!kbDir) usage();
      const name = flag("--name");
      const { kb, name: shelfName, report } = await importShelf(registry, kbDir, name);
      console.log(
        `Imported shelf "${shelfName}" at ${kb.bundle.root} — conformant: ${report.conformant}, ${report.conceptCount} concept(s)`
      );
      const errors = report.issues.filter((i) => i.severity === "error");
      if (errors.length > 0) console.error(`  errors: ${errors.map((i) => i.message).join("; ")}`);
    } else if (sub === "import-book") {
      const segDir = rest[0];
      const into = flag("--into");
      if (!segDir || !into) usage();
      const kb = await importBookIntoShelf(registry, into, segDir);
      console.log(`Imported book into shelf "${into}" (${kb.bundle.root})`);
    } else if (sub === "list") {
      const list = await registry.list();
      console.log(
        list.length === 0
          ? "(no shelves)"
          : list.map((s) => `${s.name}\t${s.conceptCount} concept(s)\t${s.root}`).join("\n")
      );
    } else {
      usage();
    }
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }
}

async function runBook(args: string[]): Promise<void> {
  const bundleRoot = process.env.BUNDLE_ROOT;
  if (!bundleRoot) {
    console.error("BUNDLE_ROOT env var is required");
    process.exit(1);
  }
  const registry = new ShelfRegistry(bundleRoot, {
    shelvesRoot: resolveShelvesRoot(),
    gitAutocommit: process.env.GIT_AUTOCOMMIT === "true",
  });
  await registry.discover();
  const libraryRoot = resolveLibraryRoot();

  const [sub, ...rest] = args;
  const flag = (name: string): string | undefined => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };

  try {
    if (sub === "import") {
      const pdfDir = rest[0];
      const into = flag("--into");
      if (!pdfDir) usage();
      const r = await importBook(registry, libraryRoot, pdfDir, into);
      console.log(
        `Imported book "${r.slug}" into shelf "${r.shelfName}" — ${r.chapterCount} chapter(s) cataloged, ` +
          `stacks at ${r.stacksDir}. Shelf conformant: ${r.report.conformant} (${r.report.conceptCount} concepts)`
      );
      const errors = r.report.issues.filter((i) => i.severity === "error");
      if (errors.length > 0) console.error(`  errors: ${errors.map((i) => i.message).join("; ")}`);
    } else {
      usage();
    }
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }
}