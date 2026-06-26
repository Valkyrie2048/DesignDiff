#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";

import { FigmaService } from "./services/figma.js";
import { RendererService } from "./services/renderer.js";
import { DiffEngine } from "./services/differ.js";
import { PatchGenerator } from "./services/patcher.js";
import { GitService } from "./services/git.js";

import { registerCheckComponentParity } from "./tools/check_component_parity.js";
import { registerFlagStaleMappings } from "./tools/flag_stale_mappings.js";
import { registerGenerateSyncPatch } from "./tools/generate_sync_patch.js";
import { registerAuditStateCoverage } from "./tools/audit_state_coverage.js";
import { registerCheckResponsiveParity } from "./tools/check_responsive_parity.js";
import { registerCheckThemeParity } from "./tools/check_theme_parity.js";

const FIGMA_API_KEY = process.env.FIGMA_API_KEY;
if (!FIGMA_API_KEY) {
  console.error("Error: FIGMA_API_KEY environment variable is required.");
  console.error("  Get your key: https://help.figma.com/hc/en-us/articles/8085703771159");
  console.error("  Usage: FIGMA_API_KEY=xxx npx designdiff-mcp");
  process.exit(1);
}

const figma = new FigmaService(FIGMA_API_KEY);
const renderer = new RendererService();
const differ = new DiffEngine();
const patcher = new PatchGenerator();
const git = new GitService();

const server = new McpServer({ name: "designdiff-mcp-server", version: "0.2.0" });

registerCheckComponentParity(server, figma, renderer, differ, patcher);
registerFlagStaleMappings(server, figma, git);
registerGenerateSyncPatch(server, figma, renderer, differ, patcher);
registerAuditStateCoverage(server, figma, renderer);
registerCheckResponsiveParity(server, figma, renderer);
registerCheckThemeParity(server, figma, renderer);

async function runStdio(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("DesignDiff MCP v0.2 — 6 tools loaded");
  process.on("SIGINT", async () => { await renderer.close(); process.exit(0); });
}

async function runHttp(): Promise<void> {
  const app = express();
  app.use(express.json());
  app.get("/health", (_req, res) => res.json({ status: "ok", version: "0.2.0", tools: 6 }));
  app.post("/mcp", async (req, res) => {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  const port = parseInt(process.env.PORT ?? "3847");
  app.listen(port, () => console.error(`DesignDiff MCP v0.2 running at http://localhost:${port}/mcp`));
  process.on("SIGINT", async () => { await renderer.close(); process.exit(0); });
}

const transport = process.env.TRANSPORT ?? "stdio";
if (transport === "http") {
  runHttp().catch(err => { console.error(err); process.exit(1); });
} else {
  runStdio().catch(err => { console.error(err); process.exit(1); });
}
