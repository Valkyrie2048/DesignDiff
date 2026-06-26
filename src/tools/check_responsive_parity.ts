import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FigmaService } from "../services/figma.js";
import { RendererService } from "../services/renderer.js";
import { MAX_RESPONSE_CHARS } from "../constants.js";

const DEFAULT_BREAKPOINTS = [
  { name: "mobile", width: 375, height: 812 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1280, height: 800 },
  { name: "wide", width: 1920, height: 1080 },
];

interface BreakpointResult {
  breakpoint: string;
  width: number;
  issues: string[];
  score: number;
}

const InputSchema = z.object({
  file_id: z.string().min(1).describe("Figma file ID"),
  node_id: z.string().min(1).describe("Figma node ID"),
  component_url: z.string().url().describe("URL where the component renders"),
  css_selector: z.string().default("#storybook-root > *"),
  breakpoints: z.array(z.object({
    name: z.string(),
    width: z.number().int().positive(),
    height: z.number().int().positive().optional().default(800),
  })).optional().describe("Custom breakpoints to test. Defaults: 375px, 768px, 1280px, 1920px"),
}).strict();

type Input = z.infer<typeof InputSchema>;

export function registerCheckResponsiveParity(
  server: McpServer,
  figma: FigmaService,
  renderer: RendererService
): void {
  server.registerTool(
    "check_responsive_parity",
    {
      title: "Check Responsive Parity",
      description: `Render a component at multiple viewport widths and detect layout, spacing, and visibility issues that only appear at specific breakpoints.

Catches the most common mobile implementation gap: designers provide responsive variants in Figma, developers implement desktop-only. This tool renders at each breakpoint, extracts layout properties, and surfaces issues like text overflow, collapsed containers, wrong flex direction, or elements that should be hidden but aren't.

Returns: per-breakpoint score, issues detected at each width, and a prioritized list of responsive fixes.`,
      inputSchema: InputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async (params: Input) => {
      try {
        const breakpoints = params.breakpoints ?? DEFAULT_BREAKPOINTS;
        const results: BreakpointResult[] = [];

        for (const bp of breakpoints) {
          const issues: string[] = [];

          try {
            const rendered = await renderer.getComputedStylesAtViewport(
              params.component_url,
              params.css_selector,
              bp.width,
              bp.height ?? 800
            );

            // Check for common responsive failures
            const width = parseFloat(rendered.computed["width"] ?? "0");
            const overflow = rendered.computed["overflow"] ?? "visible";

            if (width > bp.width) {
              issues.push(`Component width (${Math.round(width)}px) exceeds viewport (${bp.width}px) — horizontal scroll or clipping`);
            }

            const fontSize = parseFloat(rendered.computed["font-size"] ?? "16");
            if (bp.width <= 375 && fontSize < 14) {
              issues.push(`Font size ${fontSize}px is below 14px minimum for mobile readability`);
            }

            const padding = parseFloat(rendered.computed["padding-left"] ?? "0");
            if (bp.width <= 768 && padding > bp.width * 0.15) {
              issues.push(`Padding (${Math.round(padding)}px) is >15% of viewport width — content area may be too narrow`);
            }

            if (overflow === "hidden" && width <= bp.width * 0.5 && bp.width >= 768) {
              issues.push(`Component appears collapsed — may be missing responsive width rule for this breakpoint`);
            }

          } catch (err) {
            issues.push(`Could not render at ${bp.width}px: ${err instanceof Error ? err.message : "unknown error"}`);
          }

          results.push({
            breakpoint: bp.name,
            width: bp.width,
            issues,
            score: Math.max(0, 100 - issues.length * 25),
          });
        }

        return {
          content: [{ type: "text", text: formatResponsiveReport(results, params.node_id).slice(0, MAX_RESPONSE_CHARS) }],
          structuredContent: JSON.parse(JSON.stringify({ nodeId: params.node_id, results })) as Record<string, unknown>,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `## ❌ Responsive check failed\n\n${message}` }],
          isError: true,
        };
      }
    }
  );
}

function formatResponsiveReport(results: BreakpointResult[], nodeId: string): string {
  const totalIssues = results.reduce((sum, r) => sum + r.issues.length, 0);
  const worstBp = results.sort((a, b) => a.score - b.score)[0];

  const verdict = totalIssues === 0
    ? `✅ **Responsive parity confirmed across all ${results.length} breakpoints.**`
    : `🟠 **${totalIssues} responsive issue${totalIssues === 1 ? "" : "s"} found across ${results.filter(r => r.issues.length > 0).length} breakpoint${results.filter(r => r.issues.length > 0).length === 1 ? "" : "s"}.**`;

  const lines = [
    verdict,
    `Component: \`${nodeId}\``,
    ``,
  ];

  for (const r of results) {
    const icon = r.score === 100 ? "✅" : r.score >= 75 ? "🟡" : "🔴";
    lines.push(`${icon} **${r.breakpoint}** (${r.width}px) — score ${r.score}/100`);
    if (r.issues.length > 0) {
      for (const issue of r.issues) {
        lines.push(`   ⚠️ ${issue}`);
      }
    }
    lines.push(``);
  }

  if (worstBp && worstBp.score < 100) {
    lines.push(`> Worst breakpoint: **${worstBp.breakpoint}** at ${worstBp.width}px. Fix mobile first — it often surfaces structural issues that cascade up.`);
  }

  return lines.join("\n");
}
