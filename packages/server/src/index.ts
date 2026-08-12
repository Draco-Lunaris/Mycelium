import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import { ShelfRegistry, resolveFallbackConfig, resolveLibraryRoot, resolveModelConfig, resolveShelvesRoot } from "@mycelium/core";
import { mcpRouter } from "./mcp/http.js";
import { browseRouter } from "./api/browse.js";
import { chatRouter } from "./api/chat.js";
import { ingestRouter } from "./api/ingest.js";
import { activityRouter } from "./api/activity.js";
import { bearerAuth } from "./auth.js";
import { startDreamer } from "./dreamer.js";

const bundleRoot = process.env.BUNDLE_ROOT;
if (!bundleRoot) {
  console.error("BUNDLE_ROOT env var is required");
  process.exit(1);
}

const registry = new ShelfRegistry(bundleRoot, {
  shelvesRoot: resolveShelvesRoot(),
  gitAutocommit: process.env.GIT_AUTOCOMMIT === "true",
});
const shelves = await registry.discover();
if (shelves.length > 0) console.log(`[mycelium] shelves: ${shelves.join(", ")}`);

// Library stacks root for book ingest (LIBRARY_ROOT env, or a `library/` sibling
// of BUNDLE_ROOT). Tolerate an unset BUNDLE_ROOT the way tryLibraryRoot did.
const libraryRoot = (() => {
  try {
    return resolveLibraryRoot(process.env);
  } catch {
    return undefined;
  }
})();

startDreamer(registry);

const app = express();

// Validate LLM config at startup — fail fast with a clear error.
try {
  const primaryConfig = resolveModelConfig();
  console.log(
    `[mycelium] model: ${primaryConfig.format}:${primaryConfig.model || "auto"} @ ${primaryConfig.baseURL}`
  );
  const fallbackConfig = resolveFallbackConfig();
  if (fallbackConfig) {
    console.log(
      `[mycelium] fallback: ${fallbackConfig.format}:${fallbackConfig.model || "auto"} @ ${fallbackConfig.baseURL}`
    );
  }
} catch (err) {
  console.error(`[mycelium] LLM configuration error: ${(err as Error).message}`);
  console.error("[mycelium] Set LLM_API_BASE_URL + LLM_API_KEY, or configure legacy env vars.");
  process.exit(1);
}

// Reflect the request origin; expose Mcp-Session-Id so browser MCP clients can
// read it back off the initialize response.
app.use(
  cors({
    origin: true,
    exposedHeaders: ["Mcp-Session-Id"],
    allowedHeaders: [
      "Content-Type",
      "Accept",
      "Authorization",
      "Mcp-Session-Id",
      "Mcp-Protocol-Version",
      "Last-Event-ID",
    ],
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
  })
);
// JSON body limit for endpoints like /api/chat. Book ingest uses multipart
// (POST /api/ingest-book) with its own INGEST_LIMIT_MB. Override the JSON
// limit with MAX_BODY_MB (e.g. "32") for very large chat payloads.
app.use(express.json({ limit: process.env.MAX_BODY_MB ? `${process.env.MAX_BODY_MB}mb` : "16mb" }));

// Optional bearer auth (issue #1): protects the memory (/mcp + /api) when
// AUTH_TOKEN is set. Static web UI stays open and prompts for the token.
const authToken = process.env.AUTH_TOKEN;
if (authToken) {
  app.use(["/mcp", "/api"], bearerAuth(authToken));
  console.log("[mycelium] auth: bearer token required for /mcp and /api");
} else {
  console.log("[mycelium] auth: disabled (set AUTH_TOKEN to protect /mcp and /api)");
}

app.use("/mcp", mcpRouter(registry));
app.use("/api", browseRouter(registry));
app.use("/api", chatRouter(registry));
app.use("/api", ingestRouter(registry, libraryRoot));
app.use("/api", activityRouter());

// Serve the built web UI in production (single container), with SPA fallback.
const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^(?!\/(api|mcp)).*/, (_req, res) => {
    res.sendFile(path.join(webDist, "index.html"));
  });
}

const port = Number(process.env.PORT ?? 3800);
app.listen(port, "0.0.0.0", () => {
  const shelfNote = shelves.length > 0 ? ` + ${shelves.length} shelf${shelves.length === 1 ? "" : "s"}` : "";
  console.log(`mycelium serving bundle ${bundleRoot}${shelfNote} on :${port} (web + /api + /mcp)`);
});
