import express, { type Router } from "express";
import {
  BundleError,
  ShelfNotFoundError,
  TraceStore,
  resolveFallbackConfig,
  resolveModelConfig,
  type KnowledgeBase,
  type ShelfRegistry,
} from "@mycelium/core";

/** Resolve a shelf (or global) from a request's `?shelf=` query param. */
function kbFromQuery(registry: ShelfRegistry, req: { query: { shelf?: string } }): KnowledgeBase | { error: string; status: number } {
  try {
    return registry.get(req.query.shelf);
  } catch (err) {
    if (err instanceof ShelfNotFoundError) return { error: err.message, status: 404 };
    return { error: err instanceof Error ? err.message : String(err), status: 400 };
  }
}

/** Deterministic browse API — no LLM involved, browsing never costs tokens. */
export function browseRouter(registry: ShelfRegistry): Router {
  const router = express.Router();

  router.get("/shelves", async (_req, res) => {
    res.json(await registry.list());
  });

  router.get("/tree", async (req, res) => {
    const kb = kbFromQuery(registry, req);
    if ("error" in kb) return res.status(kb.status).json({ error: kb.error });
    res.json(await kb.listTree());
  });

  router.get("/concept", async (req, res) => {
    const kb = kbFromQuery(registry, req);
    if ("error" in kb) return res.status(kb.status).json({ error: kb.error });
    const path = String(req.query.path ?? "");
    try {
      res.json(await kb.readConcept(path));
    } catch (err) {
      if (err instanceof BundleError) {
        res.status(err.code === "NOT_FOUND" ? 404 : 400).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  router.get("/search", async (req, res) => {
    const kb = kbFromQuery(registry, req);
    if ("error" in kb) return res.status(kb.status).json({ error: kb.error });
    const q = String(req.query.q ?? "");
    const type = req.query.type ? String(req.query.type) : undefined;
    const tag = req.query.tag ? String(req.query.tag) : undefined;
    res.json(await kb.search(q, { type, tags: tag ? [tag] : undefined }));
  });

  router.get("/log", async (req, res) => {
    const kb = kbFromQuery(registry, req);
    if ("error" in kb) return res.status(kb.status).json({ error: kb.error });
    res.json(await kb.readLog());
  });

  router.get("/validate", async (req, res) => {
    const kb = kbFromQuery(registry, req);
    if ("error" in kb) return res.status(kb.status).json({ error: kb.error });
    res.json(await kb.validate());
  });

  router.get("/graph", async (req, res) => {
    const kb = kbFromQuery(registry, req);
    if ("error" in kb) return res.status(kb.status).json({ error: kb.error });
    res.json(await kb.graph());
  });

  router.get("/traces", async (req, res) => {
    const kb = kbFromQuery(registry, req);
    if ("error" in kb) return res.status(kb.status).json({ error: kb.error });
    const traces = new TraceStore(kb.bundle.root);
    // List view: omit full steps/answers to keep the payload light.
    const all = await traces.list();
    res.json(
      all.map(({ id, kind, input, startedAt, durationMs, notation, steps }) => ({
        id,
        kind,
        input,
        startedAt,
        durationMs,
        notation,
        stepCount: steps.length,
      }))
    );
  });

  router.get("/trace", async (req, res) => {
    const kb = kbFromQuery(registry, req);
    if ("error" in kb) return res.status(kb.status).json({ error: kb.error });
    const traces = new TraceStore(kb.bundle.root);
    const trace = await traces.read(String(req.query.id ?? ""));
    if (!trace) {
      res.status(404).json({ error: "trace not found" });
      return;
    }
    res.json(trace);
  });

  router.get("/types", async (req, res) => {
    const kb = kbFromQuery(registry, req);
    if ("error" in kb) return res.status(kb.status).json({ error: kb.error });
    res.json(await kb.listTypes());
  });

  router.get("/config", (_req, res) => {
    const config = resolveModelConfig();
    const fallback = resolveFallbackConfig();
    res.json({
      model: config.model,
      format: config.format,
      fallbackConfigured: fallback !== null,
    });
  });

  return router;
}