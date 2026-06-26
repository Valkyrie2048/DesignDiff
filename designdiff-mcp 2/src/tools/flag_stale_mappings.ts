import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FigmaService } from "../services/figma.js";
import { GitService } from "../services/git.js";
import { MAX_RESPONSE_CHARS } from "../constants.js";
import type { StaleMappingsReport, CodeConnectMapping } from "../types.js";

const InputSchema = z.object({
  file_id: z.string().min(1).describe("Figma file ID to audit"),
  repo_root: z.string().default(".").describe("Path to your repository root (default: current directory)"),
  staleness_only: z.boolean().default(true).describe("Only return stale/critical results"),
}).strict();

type Input = z.infer<typeof InputSchema>;

export function registerFlagStaleMappings(
  server: McpServer,
  figma: FigmaService,
  git: GitService
): void {
  server.registerTool(
    "flag_stale_mappings",
    {
      title: "Flag Stale Code Connect Mappings",
      description: `Audit all Code Connect mappings in a Figma file for drift. Returns components where design has changed after the connected code file was last updated — ranked by severity, impact, and days since divergence.

Reads from .figma/code-connect.json in your repo root. Returns actionable summary with specific components to fix first, estimated blast radius, and direct commands to check each one.`,
      inputSchema: InputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async (params: Input) => {
      try {
        const rawMappings = await figma.getFileCodeConnectMappings(params.file_id);

        if (rawMappings.length === 0) {
          return {
            content: [{ type: "text", text: formatNoComponents(params.file_id) }],
          };
        }

        const report = await git.buildStaleMappingsReport(
          params.file_id,
          rawMappings.map(m => ({ nodeId: m.nodeId, componentName: m.componentName, lastModified: m.lastModified })),
          params.repo_root
        );

        if (report.totalMappings === 0) {
          return { content: [{ type: "text", text: formatNoMappings(rawMappings.length) }] };
        }

        const filtered: StaleMappingsReport = params.staleness_only
          ? { ...report, mappings: report.mappings.filter(m => m.staleness !== "fresh") }
          : report;

        return {
          content: [{ type: "text", text: formatReport(filtered).slice(0, MAX_RESPONSE_CHARS) }],
          structuredContent: JSON.parse(JSON.stringify(filtered)) as Record<string, unknown>,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `## ❌ Mapping audit failed\n\n${message}` }],
          isError: true,
        };
      }
    }
  );
}

function formatReport(report: StaleMappingsReport): string {
  const lines: string[] = [];

  // Verdict line
  if (report.staleMappings === 0) {
    lines.push(`✅ **All ${report.totalMappings} mappings are current.** No drift detected.`);
    return lines.join("\n");
  }

  const urgencyIcon = report.criticalMappings > 0 ? "🔴" : "🟡";
  lines.push(
    `${urgencyIcon} **${report.staleMappings} of ${report.totalMappings} components have drifted from their Figma specs.**`,
    ``,
    `${report.criticalMappings} critical (30+ days) · ${report.staleMappings - report.criticalMappings} stale (7–30 days)`,
    ``,
  );

  // Blast radius estimate
  const highImpact = report.mappings.filter(m => m.impact === "high" && m.staleness !== "fresh");
  if (highImpact.length > 0) {
    lines.push(
      `## ⚠️ Blast Radius`,
      ``,
      `These ${highImpact.length} high-impact component${highImpact.length === 1 ? "" : "s"} are used across your design system. Drift here affects every screen they appear on:`,
      ``,
      ...highImpact.map(m => `- **${m.figmaComponentName}** — ${m.daysSinceSync} days since design changed, code not updated`),
      ``,
    );
  }

  // Critical
  const critical = report.mappings.filter(m => m.staleness === "critical");
  if (critical.length > 0) {
    lines.push(`## 🔴 Critical — fix this sprint`, ``);
    for (const m of critical) lines.push(...formatMappingBlock(m));
  }

  // Stale
  const stale = report.mappings.filter(m => m.staleness === "stale");
  if (stale.length > 0) {
    lines.push(`## 🟡 Stale — schedule soon`, ``);
    for (const m of stale) lines.push(...formatMappingBlock(m));
  }

  // Action plan
  const topThree = report.mappings.slice(0, 3);
  if (topThree.length > 0) {
    lines.push(
      `## 🎯 Suggested Action Plan`,
      ``,
      `Run these checks first, in order:`,
      ``,
      ...topThree.map((m, i) =>
        `${i + 1}. \`check_component_parity\` on **${m.figmaComponentName}** (\`${m.codePath}\`)`
      ),
      ``,
      `Each check will tell you exactly what changed and generate a patch if needed.`,
    );
  }

  return lines.join("\n");
}

function formatMappingBlock(m: CodeConnectMapping): string[] {
  return [
    `**${m.figmaComponentName}** [impact: ${m.impact}]`,
    `   Code: \`${m.codePath}\``,
    `   Design last updated: ${m.figmaLastModified.slice(0, 10)}`,
    `   Code last updated:   ${m.codeLastModified.slice(0, 10)}`,
    `   Gap: **${m.daysSinceSync} day${m.daysSinceSync === 1 ? "" : "s"}**`,
    ``,
  ];
}

function formatNoComponents(fileId: string): string {
  return [
    `## No components found in file \`${fileId}\``,
    ``,
    `**Check:**`,
    `- FIGMA_API_KEY has read access to this file`,
    `- The file_id is correct (Figma URL: figma.com/file/{file_id}/...)`,
    `- The file contains published components (not just frames)`,
  ].join("\n");
}

function formatNoMappings(componentCount: number): string {
  return [
    `## No Code Connect mappings found`,
    ``,
    `Found ${componentCount} Figma component${componentCount === 1 ? "" : "s"} but none have Code Connect entries.`,
    ``,
    `**To set up Code Connect:**`,
    `1. Create \`.figma/code-connect.json\` in your repo root`,
    `2. Format:`,
    `\`\`\`json`,
    `{`,
    `  "connections": [`,
    `    {`,
    `      "figmaNode": "123:456",`,
    `      "component": "Button",`,
    `      "filepath": "src/components/Button.tsx"`,
    `    }`,
    `  ]`,
    `}`,
    `\`\`\``,
    `3. Re-run \`flag_stale_mappings\``,
  ].join("\n");
}
