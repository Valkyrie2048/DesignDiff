import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FigmaService } from "../services/figma.js";
import { RendererService } from "../services/renderer.js";
import { DiffEngine } from "../services/differ.js";
import { PatchGenerator } from "../services/patcher.js";
import { SourceScanner } from "../services/source-scanner.js";
import { buildNarrative, type EnrichedMismatch } from "../services/intelligence.js";
import { DEFAULT_PARITY_THRESHOLD, MAX_RESPONSE_CHARS } from "../constants.js";
import type { ParityReport, SourceComplianceReport, ConfidenceLevel } from "../types.js";

const InputSchema = z.object({
  file_id: z.string().min(1).describe("Figma file ID (from URL: figma.com/file/{file_id}/...)"),
  node_id: z.string().min(1).describe("Figma node ID of the component (e.g. '123:456')"),
  component_url: z.string().url().describe("URL where the component renders (Storybook story, localhost preview)"),
  css_selector: z.string()
    .default("#storybook-root > *, [data-testid], .component")
    .describe("CSS selector for the component root. Common: '#storybook-root > *' for Storybook"),
  code_path: z.string().describe("Path to the component source file (e.g. 'src/components/Button.tsx')"),
  threshold: z.number().int().min(0).max(100).default(DEFAULT_PARITY_THRESHOLD)
    .describe("Parity score below which a patch is suggested (default: 80)"),
  auto_patch: z.boolean().default(true)
    .describe("Automatically generate and return a patch when score is below threshold. Default: true."),
  scan_source: z.boolean().default(true)
    .describe("Also scan the source file for hardcoded values that bypass design tokens. Default: true."),
}).strict();

type Input = z.infer<typeof InputSchema>;

export function registerCheckComponentParity(
  server: McpServer,
  figma: FigmaService,
  renderer: RendererService,
  differ: DiffEngine,
  patcher: PatchGenerator,
): void {
  const scanner = new SourceScanner();

  server.registerTool(
    "check_component_parity",
    {
      title: "Check Component Parity",
      description: `Compare a Figma design spec against live rendered code. Returns a scored parity report with:

• Visual Fidelity — computed browser styles vs Figma spec (spacing, color, typography, borders)
• Source Compliance — AST scan of source file for hardcoded values bypassing design tokens
• State Coverage — hover, focus, disabled states compared against Figma variants
• Confidence levels — Verified / Likely / Unable to Verify on every finding
• Patch-ready unified diff — real line numbers, git apply compatible

Two verification passes:
1. COMPUTED STYLES: Playwright renders the component and reads getComputedStyle(). Catches cascade failures and runtime issues. Limitation: var(--token) and #hardcoded resolve identically.
2. SOURCE SCAN: Reads the source file directly to detect hardcoded values that should be tokens. Catches what computed styles cannot.

When auto_patch is true and score < threshold, a unified diff is included — no second tool call needed.`,
      inputSchema: InputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (params: Input) => {
      try {
        // Run Figma spec fetch + browser render in parallel
        const [spec, rendered] = await Promise.all([
          figma.getNodeSpec(params.file_id, params.node_id),
          renderer.getComputedStyles(params.component_url, params.css_selector),
        ]);

        const report = differ.diff(spec, rendered, params.code_path);
        const narrative = buildNarrative(report);

        // Source compliance scan — runs if scan_source and code_path provided
        let sourceReport: SourceComplianceReport | null = null;
        if (params.scan_source && params.code_path) {
          const tokenMap = scanner.buildTokenMap(
            Object.fromEntries(
              Object.entries(spec.tokens).map(([k, v]) => [k, v])
            )
          );
          const scanResult = await scanner.scan(params.code_path, tokenMap);
          sourceReport = {
            filePath: scanResult.filePath,
            canScan: scanResult.canScan,
            sourceCompliance: scanResult.sourceCompliance,
            hardcodedColors: scanResult.violations.filter(v => v.type === "hardcoded-color").length,
            hardcodedSpacing: scanResult.violations.filter(v => v.type === "hardcoded-spacing").length,
            tokenUsageCount: scanResult.tokenUsageFound.length,
            violations: scanResult.violations.map(v => ({
              type: v.type,
              value: v.value,
              suggestedToken: v.suggestedToken,
              line: v.line,
              context: v.context,
              confidence: v.confidence as ConfidenceLevel,
            })),
            note: buildSourceNote(scanResult),
          };
        }

        // Annotate mismatches with confidence levels
        const annotatedMismatches = report.mismatches.map(m => ({
          ...m,
          confidence: getConfidence(m.category) as ConfidenceLevel,
          verificationMethod: (m.category === "state" ? "state-check" : "computed-style") as
            "computed-style" | "source-scan" | "state-check",
        }));

        // Generate patch if below threshold
        let patch = null;
        if (params.auto_patch && report.score < params.threshold && report.patchAvailable) {
          patch = await patcher.generatePatch(report, "diff");
        }

        const text = formatFullReport(report, narrative, patch, params.threshold, sourceReport, annotatedMismatches);

        return {
          content: [{ type: "text", text: text.slice(0, MAX_RESPONSE_CHARS) }],
          structuredContent: JSON.parse(JSON.stringify({
            report,
            narrative,
            patch,
            sourceCompliance: sourceReport,
            mismatches: annotatedMismatches,
          })) as Record<string, unknown>,
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

function getConfidence(category: string): ConfidenceLevel {
  // Computed styles give us high confidence on visual properties
  // but cannot verify token usage (the fundamental limitation)
  switch (category) {
    case "spacing": return "verified";       // px values are exact from getComputedStyle
    case "typography": return "verified";    // font-size, weight are exact
    case "border": return "verified";        // border-width is exact
    case "color": return "likely";           // color values may differ in color space
    case "token": return "likely";           // we see wrong value, can't confirm token vs hardcode
    case "state": return "likely";           // state detection via interaction simulation
    default: return "unable-to-verify";
  }
}

function buildSourceNote(result: import("../services/source-scanner.js").SourceScanResult): string {
  if (!result.canScan) return "Source file not found or not scannable — source compliance check skipped.";
  if (result.violations.length === 0) {
    return `No hardcoded values detected. ${result.tokenUsageFound.length} CSS custom properties in use.`;
  }
  const colors = result.violations.filter(v => v.type === "hardcoded-color").length;
  const spacing = result.violations.filter(v => v.type === "hardcoded-spacing").length;
  const withSuggestions = result.violations.filter(v => v.suggestedToken).length;
  return [
    `Found ${result.violations.length} hardcoded value${result.violations.length === 1 ? "" : "s"} in source`,
    colors > 0 ? `${colors} color${colors === 1 ? "" : "s"}` : null,
    spacing > 0 ? `${spacing} spacing value${spacing === 1 ? "" : "s"}` : null,
    withSuggestions > 0 ? `${withSuggestions} with known token substitution` : null,
    result.tokenUsageFound.length > 0 ? `${result.tokenUsageFound.length} CSS vars already in use` : null,
  ].filter(Boolean).join(" · ") + ".";
}

function formatFullReport(
  report: ParityReport,
  narrative: ReturnType<typeof buildNarrative>,
  patch: Awaited<ReturnType<PatchGenerator["generatePatch"]>> | null,
  threshold: number,
  sourceReport: SourceComplianceReport | null,
  annotatedMismatches: Array<ParityReport["mismatches"][0] & { confidence: ConfidenceLevel; verificationMethod: string }>
): string {
  const RISK_ICONS = { low: "🟢", medium: "🟡", high: "🟠", critical: "🔴" };
  const riskIcon = RISK_ICONS[narrative.riskLevel];
  const CONF_ICONS: Record<ConfidenceLevel, string> = {
    "verified": "✓",
    "likely": "~",
    "unable-to-verify": "?",
  };

  const lines: string[] = [
    `${riskIcon} **${narrative.headline}**`,
    ``,
    narrative.summary,
    ``,
    `⏱ Fix time: **${narrative.estimatedFixTime}**  ·  Risk: **${narrative.riskLevel}**  ·  Grade: **${report.grade}**`,
    ``,
  ];

  if (narrative.patternDetected) {
    lines.push(`> 💡 **Pattern detected:** ${narrative.patternDetected}`, ``);
  }

  // ── Visual Fidelity (computed styles) ──
  if (report.mismatches.length > 0) {
    lines.push(`## Visual Fidelity Issues  (${report.mismatches.length} found)`, ``);
    lines.push(`*Verified via computed browser styles. Confidence key: ✓ Verified  ~ Likely  ? Unable to verify*`, ``);

    for (const m of report.mismatches.map((mm, idx) => ({ ...mm, confidence: (annotatedMismatches[idx] as unknown as { confidence: ConfidenceLevel }).confidence ?? "likely" }))) {
      const icon = m.severity === "critical" ? "🔴" : m.severity === "warning" ? "🟡" : "🔵";
      const conf = CONF_ICONS[m.confidence];
      const autofix = m.category !== "state" ? " · patch-ready" : " · manual impl required";
      lines.push(`${icon} [${conf}] **${m.property}** \`[${m.category}]\`${autofix}`);
      lines.push(`   Design: \`${m.designValue}\``);
      lines.push(`   Code:   \`${m.codeValue}\``);
      if (m.fix) lines.push(`   Fix: ${m.fix}`);
      lines.push(``);
    }
  } else {
    lines.push(`✅ **Visual Fidelity: No mismatches.**`, ``);
  }

  // ── Source Compliance (AST scan) ──
  if (sourceReport) {
    const compIcon = sourceReport.sourceCompliance >= 90 ? "✅" :
                     sourceReport.sourceCompliance >= 70 ? "🟡" : "🔴";

    if (!sourceReport.canScan) {
      lines.push(`## Source Compliance`, ``, `> ⚠️ ${sourceReport.note}`, ``);
    } else {
      lines.push(
        `## Source Compliance  ${compIcon} ${sourceReport.sourceCompliance}/100`,
        ``,
        sourceReport.note,
        ``,
      );

      if (sourceReport.violations.length > 0) {
        lines.push(`*Source scan: these values bypass your design token contract*`, ``);
        for (const v of sourceReport.violations.slice(0, 10)) { // cap at 10
          const conf = CONF_ICONS[v.confidence];
          lines.push(`[${conf}] Line ${v.line}: \`${v.value}\`${v.suggestedToken ? ` → use \`${v.suggestedToken}\`` : ""}`);
          lines.push(`   \`${v.context}\``);
          lines.push(``);
        }
        if (sourceReport.violations.length > 10) {
          lines.push(`*… and ${sourceReport.violations.length - 10} more. Run \`generate_sync_patch\` for full list.*`, ``);
        }
      }

      if (sourceReport.tokenUsageCount > 0) {
        lines.push(`**Tokens already in use:** ${sourceReport.violations.filter(v => v.type === "hardcoded-color" && v.suggestedToken).map(v => v.suggestedToken!).slice(0, 6).join("  ")}`, ``);
      }
    }
  }

  // ── Category Scores ──
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
  if (sourceReport?.canScan) {
    const filled = Math.round(sourceReport.sourceCompliance / 10);
    const bar = "█".repeat(filled) + "░".repeat(10 - filled);
    lines.push(`📝 ${"source".padEnd(10)} ${bar} ${sourceReport.sourceCompliance}/100  (AST scan)`);
  }
  lines.push(``);

  // ── Quick Wins ──
  if (narrative.quickWins.length > 0) {
    lines.push(`## ⚡ Quick Wins`, ``);
    for (const qw of narrative.quickWins) {
      lines.push(`- \`${qw.property}\`: \`${qw.codeValue}\` → \`${qw.designValue}\``);
    }
    lines.push(``);
  }

  // ── Patch ──
  if (patch) {
    lines.push(
      `## ✨ Patch  (${report.score} → ~${patch.estimatedScoreAfter})`,
      ``,
      `\`\`\`diff`,
      patch.patch,
      `\`\`\``,
      ``,
      `Apply: \`git apply <(cat << 'PATCH'\n${patch.patch}\nPATCH)\``,
      `Then re-run \`check_component_parity\` to confirm score improved.`,
      ``,
    );

    if (narrative.requiresDesigner.length > 0) {
      lines.push(`### Requires manual implementation:`, ``);
      for (const rd of narrative.requiresDesigner) {
        lines.push(`- **${rd.property}**: ${(rd as EnrichedMismatch & { consequence?: string }).consequence ?? rd.fix}`);
      }
    }
  } else if (report.score < threshold && report.patchAvailable) {
    lines.push(`> Run \`generate_sync_patch\` with node_id="${report.nodeId}" to generate a patch for ${report.mismatches.filter(m => m.category !== "state").length} issue(s).`);
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
    `- node_id \`${params.node_id}\` exists in that file (right-click component → Copy link → extract node-id param)`,
    `- \`${params.component_url}\` is reachable from this machine`,
    `- Selector \`${params.css_selector}\` matches an element on the page`,
    `- For Storybook, ensure the story is fully loaded before the selector appears`,
  ].join("\n");
}
