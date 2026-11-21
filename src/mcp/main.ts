// stdio entry point for MCP clients. Configure with env vars:
//   CLOSER_HEADLESS=1       no visible browser window
//   CLOSER_CRM_URL=...      use an already-running Pipewise CRM
//   CLOSER_CRM_PORT=4100    port for the built-in CRM (falls back to any free port)

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createCloserMcp } from "./server.js";

const mcp = createCloserMcp({
  headless: process.env.CLOSER_HEADLESS === "1",
  crmUrl: process.env.CLOSER_CRM_URL,
  crmPort: process.env.CLOSER_CRM_PORT ? Number(process.env.CLOSER_CRM_PORT) : undefined,
});

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  await mcp.close().catch(() => {});
  process.exit(0);
};
process.stdin.on("close", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await mcp.server.connect(new StdioServerTransport());
process.stderr.write("[closer] MCP server ready on stdio\n");
