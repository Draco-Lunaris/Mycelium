import express, { type Router } from "express";
import { convertToModelMessages, type UIMessage } from "ai";
import { streamChat, type ShelfRegistry } from "@mycelium/core";

interface ChatBody {
  messages: UIMessage[];
  model?: string;
  shelf?: string;
}

/**
 * Streaming chat endpoint for the web UI (`useChat`). Full agent toolset —
 * the chat exists to exercise the same agent the MCP server uses. An optional
 * `shelf` in the body scopes the call to an independent topic store.
 */
export function chatRouter(registry: ShelfRegistry): Router {
  const router = express.Router();

  router.post("/chat", async (req, res) => {
    const { messages, model, shelf } = req.body as ChatBody;
    let kb;
    try {
      kb = registry.get(shelf);
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
      return;
    }
    const { result } = await streamChat(kb, convertToModelMessages(messages), { model });
    const response = result.toUIMessageStreamResponse();
    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));
    if (response.body) {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        res.write(chunk);
      }
    }
    res.end();
  });

  return router;
}