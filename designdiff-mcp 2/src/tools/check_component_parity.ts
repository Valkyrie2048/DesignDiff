import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FigmaService } from "../services/figma.js";
import { RendererService } from "../services/renderer.js";
import { DiffEngine } from "../services/differ.js";
import { PatchGenerator } from "../services/patcher.js";
import { buildNarrative, type EnrichedMismatch } from "../services/intelligence.js";
import { DEFAULT_PARITY_THRESHOLD, MAX_RESPONSE_CHARS } from "../constants.js";
import type { ParityReport } from "../types.js";

const InputSchema = z.object({
  file_id: z.string().min(1).describe("Figma file ID (from URL: figma.com/file/{file_id}/...)"),
  node_id: z.string().min(1).describe("Figma node ID of the component (e.g. '123:456')"),
  component_url: z.string().url().describe("URL where the component renders (Storybook story, localhost preview)"),
  css_selector: z.string()
    .default("#storybook-root > *, [data-testid], .component")
    .describe("CSS selector for the component root. Common: '#storybook-root > *' for Storybook"),
  code_path: z.string().describe("Path to the component source file (e.g. 'src/components/Button.tsx')"),
  threshold: z.number().int().min(0).max(100).default(DEFAULT_PARITY_THRESHOLD)
    .describe("Parity score below which a patch is auto-suggested (default: 80)"),
  auto_patch: z.boolean().default(true)
    .describe("Automatically generate and return a patch when score is below threshold. Default: true."),
}).strict();

type Input = z.infer<typeof InputSchema>;

export function registerCheckComponentParity(
  server: McpServer,
  figma: FigmaService,
  renderer: RendererService,
  differ: DiffEngine,
  patcher: PatchGenerator,
): void {
  server.registerTool(
    "check_component_parity",
    {
      title: "Check Component Parity",
      description: `Compare a Figma design spec against live rendered code. Returns a scored parity report with consequence-aware mismatch analysis, pattern detection, and — when score is below threshold — an automatically generated patch.

This tool reads COMPUTED styles (what the browser actually renders) not source code, catching cascade failures, utility-class overrides, and runtime issues that source analysis misses.

When auto_patch is true (default) and score < threshold, the patch is included in the response — no second tool call needed.

Returns: score, grade, narrative headline, mismatches with consequences, quick wins, estimated fix time, detected patterns, and optional patch.`,
      inputSchema: InputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (params: Input) => {
      try {
        const [spec, rendered] = await Promise.all([
          figma.getNodeSpec(params.file_id, params.node_id),
          renderer.getComputedStyles(params.component_url, params.css_selector),
        ]);

        const report = differ.diff(spec, rendered, params.code_path);
        const narrative = buildNarrative(report);

        // Auto-patch if below threshold — no second tool call needed
        let patch = null;
        if (params.auto_patch && report.score < params.threshold && report.patchAvailable) {
          patch = await patcher.generatePatch(report, "diff");
        }

        const text = formatFullReport(report, narrative, patch, params.threshold);

        return {
          content: [{ type: "text", text: text.slice(0, MAX_RESPONSE_CHARS) }],
          structuredContent: JSON.parse(JSON.stringify({ report, narrative, patch })) as Record<string, unknown>,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: formatError(message, params) }],
          isError: true,
        };
      }
    }
  );
}

function formatFullReport(
  report: ParityReport,
  narrative: ReturnType<typeof buildNarrative>,
  patch: Awaited<ReturnType<PatchGenerator["generatePatch"]>> | null,
  threshold: number
): string {
  const RISK_ICONS = { low: "🟢", medium: "🟡", high: "🟠", critical: "🔴" };
  const riskIcon = RISK_ICONS[narrative.riskLevel];

  const lines: string[] = [
    `${riskIcon} **${narrative.headline}**`,
    ``,
    narrative.summary,
    ``,
    `⏱ Fix time: **${narrative.estimatedFixTime}**  ·  Risk: **${narrative.riskLevel}**  ·  Grade: **${report.grade}**`,
    ``,
  ];

  // Pattern callout — this is the "how did it know that?" moment
  if (narrative.patternDetected) {
    lines.push(`> 💡 **Pattern detected:** ${narrative.patternDetected}`, ``);
  }

  // Mismatches with consequences
  if (report.mismatches.length > 0) {
    lines.push(`## Issues  (${report.mismatches.length} found, sorted by priority)`, ``);

    const enriched = report.mismatches.map((m, i) => {
      const effortLabel = m.category !== "state" ? " · auto-fixable" : " · needs manual impl";
      const icon = m.severity === "critical" ? "🔴" : m.severity === "warning" ? "🟡" : "🔵";
      return [
        `${icon} **${m.property}** \`[${m.category}]\`${effortLabel}`,
        `   Design: \`${m.designValue}\``,
        `   Code:   \`${m.codeValue}\``,
        `   ⚠️  ${(m as EnrichedMismatch & { consequence?: string }).consequence ?? m.fix ?? "Fix required"}`,
        m.fix ? `   Fix: ${m.fix}` : null,
        ``,
      ].filter((l): l is string => l !== null);
    });

    for (const group of enriched) lines.push(...group);
  } else {
    lines.push(`✅ **No mismatches — perfect parity achieved.**`, ``);
  }

  // Category scores as a compact bar
  lines.push(`## Category Scores`, ``);
  const catIcons: Record<string, string> = {
    spacing: "📐", color: "🎨", typography: "✍️", border: "▭", states: "🖱", tokens: "🔑"
  };
  for (const [cat, data] of Object.entries(report.categories)) {
    const filled = Math.round(data.score / 10);
    const bar = "█".repeat(filled) + "░".repeat(10 - filled);
    const icon = catIcons[cat] ?? "·";
    const status = data.failed === 0 ? "✓" : `${data.failed} issue${data.failed === 1 ? "" : "s"}`;
    lines.push(`${icon} ${cat.padEnd(10)} ${bar} ${data.score}/100  ${status}`);
  }
  lines.push(``);

  // Quick wins callout
  if (narrative.quickWins.length > 0) {
    lines.push(`## ⚡ Quick Wins (trivial fixes, auto-patchable)`, ``);
    for (const qw of narrative.quickWins) {
      lines.push(`- \`${qw.property}\`: change \`${qw.codeValue}\` → \`${qw.designValue}\``);
    }
    lines.push(``);
  }

  // Auto-generated patch — the wow moment
  if (patch) {
    lines.push(
      `## ✨ Patch — Auto-generated (score ${report.score} → ~${patch.estimatedScoreAfter})`,
      ``,
      `\`\`\`diff`,
      patch.patch,
      `\`\`\``,
      ``,
      `Apply with: \`git apply designdiff.patch\``,
      `Then re-run \`check_component_parity\` to verify.`,
      ``,
    );

    if (narrative.requiresDesigner.length > 0) {
      lines.push(`### Still needs manual implementation:`, ``);
      for (const rd of narrative.requiresDesigner) {
        lines.push(`- **${rd.property}**: ${rd.consequence}`);
      }
    }
  } else if (report.score < threshold && report.patchAvailable) {
    lines.push(`> Run \`generate_sync_patch\` with node_id="${report.nodeId}" to auto-fix ${report.mismatches.filter(m => m.category !== "state").length} issue(s).`);
  }

  return lines.join("\n");
}

function formatError(message: string, params: Input): string {
  return [
    `## ❌ Parity check failed`,
    ``,
    message,
    ``,
    `**Debug checklist:**`,
    `- FIGMA_API_KEY is set and has read access to file \`${params.file_id}\``,
    `- node_id \`${params.node_id}\` exists in that file (right-click component in Figma → Copy link → extract node-id param)`,
    `- \`${params.component_url}\` is reachable from this machine`,
    `- Selector \`${params.css_selector}\` matches an element on the page`,
    `- For Storybook, ensure the story is fully loaded before the selector appears`,
  ].join("\n");
}
