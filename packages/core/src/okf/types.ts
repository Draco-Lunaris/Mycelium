/** Frontmatter of an OKF concept. `type` is the only required field (spec §5). */
export interface ConceptFrontmatter {
  type: string;
  title?: string;
  description?: string;
  resource?: string;
  tags?: string[];
  timestamp?: string;
  /** Producer-defined keys are permitted and preserved. */
  [key: string]: unknown;
}

export interface Concept {
  /** Bundle-relative path, always starting with "/" (e.g. "/tables/customers.md"). */
  path: string;
  frontmatter: ConceptFrontmatter;
  body: string;
  raw: string;
}

export interface TreeNode {
  name: string;
  path: string;
  kind: "directory" | "concept" | "reserved";
  /** Present on concepts. */
  type?: string;
  title?: string;
  description?: string;
  children?: TreeNode[];
}

export interface SearchHit {
  path: string;
  type: string;
  title?: string;
  description?: string;
  /** Snippet of body text around the first match, if the match was in the body. */
  snippet?: string;
  score: number;
}

export type LogAction = "Creation" | "Update" | "Deletion";

export interface LogEntry {
  date: string; // YYYY-MM-DD
  action: LogAction;
  summary: string;
}

export interface ConformanceIssue {
  path: string;
  severity: "error" | "warning";
  message: string;
}

export interface ConformanceReport {
  conformant: boolean;
  conceptCount: number;
  directoryCount: number;
  issues: ConformanceIssue[];
}

export const RESERVED_FILENAMES = new Set(["index.md", "log.md", "info.md"]);
