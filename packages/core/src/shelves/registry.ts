import { promises as fs } from "node:fs";
import path from "node:path";
import { KnowledgeBase, type KnowledgeBaseOptions } from "../okf/index.js";
import type { TreeNode } from "../okf/types.js";

export interface ShelfInfo {
  name: string;
  root: string;
  conceptCount: number;
}

/** Thrown when a caller asks for a shelf that isn't registered/on disk. */
export class ShelfNotFoundError extends Error {
  constructor(public readonly shelf: string) {
    super(`Shelf not found: ${shelf}`);
    this.name = "ShelfNotFoundError";
  }
}

export interface ShelfRegistryOptions extends KnowledgeBaseOptions {
  /** Directory holding shelf subdirectories (each a full OKF bundle). */
  shelvesRoot: string;
}

/**
 * A global memory store plus N independent topic "shelves". Each shelf is a
 * full OKF bundle — its own {@link KnowledgeBase} — living as a subdirectory of
 * `shelvesRoot`. The registry resolves a shelf name to a KnowledgeBase; the
 * agent loop itself stays single-bundle-per-call (the server layer resolves a
 * shelf, then hands one KB to runQuery/runMutation/etc.).
 *
 * `get(undefined)` / `get("global")` returns the global store.
 */
export class ShelfRegistry {
  readonly global: KnowledgeBase;
  readonly shelvesRoot: string;
  private readonly kbOptions: KnowledgeBaseOptions;
  private readonly shelves = new Map<string, KnowledgeBase>();

  constructor(globalRoot: string, options: ShelfRegistryOptions) {
    this.global = new KnowledgeBase(globalRoot, options);
    this.shelvesRoot = options.shelvesRoot;
    this.kbOptions = { gitAutocommit: options.gitAutocommit };
  }

  /** The names of all currently-registered shelves (not including "global"). */
  get shelfNames(): string[] {
    return [...this.shelves.keys()];
  }

  /**
   * Resolve a shelf name to its KB. `undefined` / `"global"` → the global
   * store. Throws {@link ShelfNotFoundError} for an unknown shelf (call
   * {@link discover} / {@link register} first).
   */
  get(shelf?: string): KnowledgeBase {
    if (!shelf || shelf === "global") return this.global;
    const kb = this.shelves.get(shelf);
    if (!kb) throw new ShelfNotFoundError(shelf);
    return kb;
  }

  /** All shelves' KBs, global first. */
  all(): KnowledgeBase[] {
    return [this.global, ...this.shelves.values()];
  }

  /** Register (or replace) a shelf KB by name. Used by the import pipeline. */
  register(name: string, kb: KnowledgeBase): void {
    this.shelves.set(name, kb);
  }

  /** Forget a shelf (e.g. after it's removed from disk). */
  unregister(name: string): void {
    this.shelves.delete(name);
  }

  /**
   * Discover shelves present under `shelvesRoot` and build their KBs. Each
   * subdirectory containing an `index.md` is treated as a shelf. A missing
   * `shelvesRoot` is not an error — it means no shelves yet.
   */
  async discover(): Promise<string[]> {
    this.shelves.clear();
    let entries: string[] = [];
    try {
      entries = await fs.readdir(this.shelvesRoot);
    } catch {
      return [];
    }
    for (const name of entries) {
      if (name.startsWith(".")) continue;
      const root = path.join(this.shelvesRoot, name);
      if (await isBundleDir(root)) {
        this.shelves.set(name, new KnowledgeBase(root, this.kbOptions));
      }
    }
    return this.shelfNames;
  }

  /** Lightweight listing for the seed overview and /api/shelves. */
  async list(): Promise<ShelfInfo[]> {
    const infos: ShelfInfo[] = [];
    for (const [name, kb] of this.shelves) {
      infos.push(await shelfInfo(name, kb));
    }
    return infos;
  }
}

async function isBundleDir(root: string): Promise<boolean> {
  try {
    const st = await fs.stat(path.join(root, "index.md"));
    return st.isFile();
  } catch {
    return false;
  }
}

async function shelfInfo(name: string, kb: KnowledgeBase): Promise<ShelfInfo> {
  let conceptCount = 0;
  try {
    conceptCount = countConcepts(await kb.listTree());
  } catch {
    // empty/non-conforming shelf → 0
  }
  return { name, root: kb.bundle.root, conceptCount };
}

function countConcepts(node: TreeNode): number {
  let n = 0;
  for (const child of node.children ?? []) {
    if (child.kind === "concept") n++;
    else if (child.kind === "directory") n += countConcepts(child);
  }
  return n;
}

/**
 * Resolve the shelves root: the `SHELVES_ROOT` env var if set, otherwise a
 * `shelves/` directory sibling to `BUNDLE_ROOT`. Shelves live fully disjoint
 * from the global bundle on disk, so the global walker never descends into
 * them and no walker change is needed.
 */
export function resolveShelvesRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SHELVES_ROOT) return env.SHELVES_ROOT;
  const bundleRoot = env.BUNDLE_ROOT;
  if (!bundleRoot) throw new Error("BUNDLE_ROOT env var is required");
  return path.join(path.dirname(path.resolve(bundleRoot)), "shelves");
}