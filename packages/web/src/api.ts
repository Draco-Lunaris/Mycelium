export interface TreeNode {
  name: string;
  path: string;
  kind: "directory" | "concept" | "reserved";
  type?: string;
  title?: string;
  description?: string;
  children?: TreeNode[];
}

export interface Concept {
  path: string;
  frontmatter: Record<string, unknown> & { type: string };
  body: string;
}

export interface SearchHit {
  path: string;
  type: string;
  title?: string;
  description?: string;
  snippet?: string;
}

export interface LogEntry {
  date: string;
  action: "Creation" | "Update" | "Deletion";
  summary: string;
}

export interface ConformanceReport {
  conformant: boolean;
  conceptCount: number;
  directoryCount: number;
  issues: { path: string; severity: "error" | "warning"; message: string }[];
}

export interface GraphNode {
  path: string;
  title?: string;
  type?: string;
  description?: string;
  links: number;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: { source: string; target: string }[];
}

export interface TraceStep {
  seq: number;
  tool: string;
  summary: string;
  paths: string[];
  write?: boolean;
}

export interface TraceSummary {
  id: string;
  kind: "query" | "mutation" | "chat";
  input: string;
  startedAt: string;
  durationMs: number;
  notation: string;
  stepCount: number;
}

export interface QueryTrace extends TraceSummary {
  steps: TraceStep[];
  answer: string;
}

export interface AppConfig {
  model: string;
  format: "openai" | "anthropic" | string;
  fallbackConfigured: boolean;
}

export interface ShelfInfo {
  name: string;
  root: string;
  conceptCount: number;
}

const TOKEN_KEY = "mycelium-token";

export function getAuthToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? "";
}

export function setAuthToken(token: string): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

/** Headers for API calls — includes the bearer token when one is stored. */
export function authHeaders(): Record<string, string> {
  const token = getAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) throw new ApiError(res.status, `${res.status} ${await res.text()}`);
  return res.json();
}

/** Append an optional `shelf` query param to a URL (handles ? vs &). */
function withShelf(url: string, shelf?: string): string {
  if (!shelf) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}shelf=${encodeURIComponent(shelf)}`;
}

export const api = {
  shelves: () => get<ShelfInfo[]>("/api/shelves"),
  tree: (shelf?: string) => get<TreeNode>(withShelf("/api/tree", shelf)),
  concept: (path: string, shelf?: string) =>
    get<Concept>(withShelf(`/api/concept?path=${encodeURIComponent(path)}`, shelf)),
  search: (q: string, shelf?: string) =>
    get<SearchHit[]>(withShelf(`/api/search?q=${encodeURIComponent(q)}`, shelf)),
  log: (shelf?: string) => get<LogEntry[]>(withShelf("/api/log", shelf)),
  validate: (shelf?: string) => get<ConformanceReport>(withShelf("/api/validate", shelf)),
  graph: (shelf?: string) => get<GraphData>(withShelf("/api/graph", shelf)),
  traces: (shelf?: string) => get<TraceSummary[]>(withShelf("/api/traces", shelf)),
  trace: (id: string, shelf?: string) =>
    get<QueryTrace>(withShelf(`/api/trace?id=${encodeURIComponent(id)}`, shelf)),
  config: () => get<AppConfig>("/api/config"),
};
