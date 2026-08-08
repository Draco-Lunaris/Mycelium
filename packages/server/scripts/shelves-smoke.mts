// Shelves MCP smoke: spins up a global bundle + a "demo" shelf and exercises
// the deterministic shelf routing (no LLM calls). Run from the server package:
//   SMOKE_BUNDLE=<global-bundle> pnpm --filter @mycelium/server exec tsx scripts/shelves-smoke.mts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const globalBundle = process.env.SMOKE_BUNDLE!;
const dist = new URL("../dist/mcp/stdio.js", import.meta.url).pathname;

// Build a SHELVES_ROOT in a tmp dir with one shelf ("demo") = copy of the global bundle.
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mycelium-shelves-smoke-"));
const shelvesRoot = path.join(tmp, "shelves");
await fs.mkdir(shelvesRoot, { recursive: true });
await fs.cp(globalBundle, path.join(shelvesRoot, "demo"), { recursive: true });

const transport = new StdioClientTransport({
  command: "node",
  args: [dist],
  env: {
    ...process.env,
    BUNDLE_ROOT: globalBundle,
    SHELVES_ROOT: shelvesRoot,
  } as Record<string, string>,
});

const client = new Client({ name: "shelves-smoke", version: "0.0.1" });
await client.connect(transport);

const instructions = client.getInstructions() ?? "";
const lines = instructions.split("\n");
const shelvesIdx = lines.findIndex((l) => l.startsWith("Shelves"));
console.log("INSTRUCTIONS has Shelves section:", shelvesIdx >= 0);
if (shelvesIdx >= 0) console.log("  ", lines.slice(shelvesIdx, shelvesIdx + 3).join(" | "));

const g = await client.callTool({ name: "memory_status", arguments: {} });
console.log("\nSTATUS global:\n", (g.content as { text: string }[])[0].text);

const s = await client.callTool({ name: "memory_status", arguments: { shelf: "demo" } });
console.log("\nSTATUS shelf=demo:\n", (s.content as { text: string }[])[0].text);

const m = await client.callTool({ name: "memory_status", arguments: { shelf: "nope" } });
console.log(
  "\nSTATUS shelf=nope:",
  JSON.stringify({ isError: m.isError, text: (m.content as { text: string }[])[0].text })
);

await client.close();
await fs.rm(tmp, { recursive: true, force: true });