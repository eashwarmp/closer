#!/usr/bin/env node
// Launcher for MCP clients: runs the TypeScript server from any working directory.
import { register } from "tsx/esm/api";

register();
await import("../src/mcp/main.ts");
