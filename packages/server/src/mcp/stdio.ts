#!/usr/bin/env node
/**
 * MCP over stdio — register in Claude Code / Claude Desktop:
 *   claude mcp add mycelium -e BUNDLE_ROOT=/path/to/bundle -e LLM_API_BASE_URL=... \
 *     -e LLM_API_KEY=... -e LLM_API_FORMAT=openai -e LLM_MODEL=... \
 *     -- node <repo>/packages/server/dist/mcp/stdio.js
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ShelfRegistry, resolveFallbackConfig, resolveModelConfig, resolveShelvesRoot } from "@mycelium/core";
import { buildMcpServer } from "./server.js";

const bundleRoot = process.env.BUNDLE_ROOT;
if (!bundleRoot) {
  console.error("BUNDLE_ROOT env var is required");
  process.exit(1);
}

// Validate LLM config at startup — fail fast with a clear error. stdio's
// only output channel to the user is stderr; stdout is reserved for the
// MCP protocol stream.
try {
  const primaryConfig = resolveModelConfig();
  console.error(
    `[mycelium] model: ${primaryConfig.format}:${primaryConfig.model || "auto"} @ ${primaryConfig.baseURL}`
  );
  const fallbackConfig = resolveFallbackConfig();
  if (fallbackConfig) {
    console.error(
      `[mycelium] fallback: ${fallbackConfig.format}:${fallbackConfig.model || "auto"} @ ${fallbackConfig.baseURL}`
    );
  }
} catch (err) {
  console.error(`[mycelium] LLM configuration error: ${(err as Error).message}`);
  console.error("[mycelium] Set LLM_API_BASE_URL + LLM_API_KEY, or configure legacy env vars.");
  process.exit(1);
}

const registry = new ShelfRegistry(bundleRoot, {
  shelvesRoot: resolveShelvesRoot(),
  gitAutocommit: process.env.GIT_AUTOCOMMIT === "true",
});
const shelves = await registry.discover();
if (shelves.length > 0) console.error(`[mycelium] shelves: ${shelves.join(", ")}`);

const server = await buildMcpServer(registry);
await server.connect(new StdioServerTransport());
// stdio transport keeps the process alive; logs must go to stderr only.
console.error(`[mycelium] serving bundle ${bundleRoot}${shelves.length ? ` + ${shelves.length} shelf(s)` : ""} over stdio`);