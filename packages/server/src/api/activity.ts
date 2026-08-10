import express, { type Router } from "express";
import { activity } from "@mycelium/core";

/**
 * Activity endpoint for the web UI's global "agent working" badge. Returns the
 * process-wide tracker's snapshot — the same tracker the agent entry points
 * (runQuery / runMutation / streamChat) update, including runs triggered by
 * external MCP clients. No registry needed: the tracker is a core singleton.
 */
export function activityRouter(): Router {
  const router = express.Router();

  router.get("/activity", (_req, res) => {
    res.json(activity.snapshot());
  });

  return router;
}