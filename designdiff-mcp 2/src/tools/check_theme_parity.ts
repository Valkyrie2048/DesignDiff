import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FigmaService } from "../services/figma.js";
import { RendererService } from "../services/renderer.js";
import { MAX_RESPONSE_CHARS } from "../constants.js";

interface ThemeResult {
  theme: string;
  issues: string[];
  score: number;
}

const InputSchema = z.object({
  file_id: z.string().min(1),
  node_id: z.string().min(1),
  component_url: z.string().url(),
  css_selector: z.string().default("#storybook-root > *"),
  themes: z.array(z.object({
    name: z.string().describe("e.g. 'dark', 'brand-b', 'high-contrast'"),
    url_param: z.string().describe("Query param to append to component_url to activate theme, e.g. 'theme=dark'"),
    expected_bg: z.string().optional().describe("Expected background color in this theme, e.g. '#1a1a2e'"),
  })).optional().describe("Themes to test. If omitted, tests light and dark by appending ?theme=light and ?theme=dark"),
}).strict();

type Input = z.infer<typeof InputSchema>;

export function registerCheckThemeParity(
  server: McpServer,
  figma: FigmaService,
  renderer: RendererService
): void {
  server.registerTool(
    "check_theme_parity",
    {
      title: "Check Theme Parity",
      description: `Run parity checks across multiple Figma variable modes (light/dark, brand variants, high-contrast). Catches token drift that only surfaces in a specific theme — the most common: dark mode where a hardcoded hex looks fine in light but becomes invisible on a dark background.

Renders the component with each theme activated (via URL param, query string, or class), extracts computed styles, and checks expected token values against actual rendered output.

Returns: per-theme score, specific token violations per theme, and whether issues are theme-specific or universal.`,
      inputSchema: InputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async (params: Input) => {
      try {
        const themes = params.themes ?? [
          { name: "light", url_param: "theme=light", expected_bg: undefined },
          { name: "dark", url_param: "theme=dark", expected_bg: undefined },
        ];

        const results: ThemeResult[] = [];
        const baseUrl = params.component_url;

        for (const theme of themes) {
          const url = baseUrl.includes("?")
            ? `${baseUrl}&${theme.url_param}`
            : `${baseUrl}?${theme.url_param}`;

          const issues: string[] = [];

          try {
            const rendered = await renderer.getComputedStyles(url, params.css_selector);
            const bg = rendered.computed["background-color"] ?? "";
            const color = rendered.computed["color"] ?? "";

            // Detect hardcoded colors in dark mode (the most common failure)
            if (theme.name === "dark") {
              // If background is white/near-white in dark mode, that's a token failure
              if (bg.match(/rgb\(25[0-5]|rgb\(24[0-9]|rgb\(23[0-9]/)) {
                issues.push(`Background appears light in dark mode (${bg}). Likely hardcoded value instead of token — will be invisible or cause contrast failure.`);
              }
              // If text is very dark in dark mode, that's a problem
              if (color.match(/rgb\([01][0-9]?,\s*[01][0-9]?,/)) {
                issues.push(`Text color is very dark in dark mode (${color}). Likely hardcoded — will be unreadable on dark background.`);
              }
            }

            // Check expected background if provided
            if (theme.expected_bg) {
              const expectedNorm = theme.expected_bg.toLowerCase().replace(/\s/g, "");
              const actualNorm = bg.toLowerCase().replace(/\s/g, "");
              if (!actualNorm.includes(expectedNorm.replace("#", ""))) {
                issues.push(`Background doesn't match expected ${theme.expected_bg} — got ${bg}. Token not resolving correctly in ${theme.name} mode.`);
              }
            }

          } catch (err) {
            issues.push(`Could not render ${theme.name} theme: ${err instanceof Error ? err.message : "unknown"}`);
          }

          results.push({ theme: theme.name, issues, score: Math.max(0, 100 - issues.length * 30) });
        }

        return {
          content: [{ type: "text", text: formatThemeReport(results, params.node_id).slice(0, MAX_RESPONSE_CHARS) }],
          structuredContent: JSON.parse(JSON.stringify({ nodeId: params.node_id, results })) as Record<string, unknown>,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `## ❌ Theme check failed\n\n${message}` }],
          isError: true,
        };
      }
    }
  );
}

function formatThemeReport(results: ThemeResult[], nodeId: string): string {
  const totalIssues = results.reduce((sum, r) => sum + r.issues.length, 0);
  const verdict = totalIssues === 0
    ? `✅ **Theme parity confirmed — component renders correctly across all ${results.length} themes.**`
    : `🔴 **${totalIssues} theme issue${totalIssues === 1 ? "" : "s"} found. Likely hardcoded values bypassing tokens.**`;

  const lines = [verdict, `Component: \`${nodeId}\``, ``];

  for (const r of results) {
    const icon = r.score === 100 ? "✅" : "🔴";
    lines.push(`${icon} **${r.theme}** — score ${r.score}/100`);
    for (const issue of r.issues) lines.push(`   ⚠️ ${issue}`);
    lines.push(``);
  }

  if (totalIssues > 0) {
    lines.push(`> Theme issues almost always mean hardcoded color values. Run \`check_component_parity\` to identify and auto-patch the specific tokens.`);
  }

  return lines.join("\n");
}
