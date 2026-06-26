import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FigmaService } from "../services/figma.js";
import { RendererService } from "../services/renderer.js";
import { DiffEngine } from "../services/differ.js";
import { PatchGenerator } from "../services/patcher.js";
import { MAX_RESPONSE_CHARS } from "../constants.js";
import type { SyncPatch } from "../types.js";

const PatchFormatSchema = z.enum(["diff", "jsx", "css", "json"]);

const InputSchema = z.object({
  file_id: z.string()
    .min(1)
    .describe("Figma file ID"),
  node_id: z.string()
    .min(1)
    .describe("Figma node ID of the component to patch"),
  component_url: z.string()
    .url()
    .describe("URL where the component renders"),
  css_selector: z.string()
    .default("#storybook-root > *, [data-testid], .component")
    .describe("CSS selector for the component root element"),
  code_path: z.string()
    .describe("Path to the component source file (e.g. 'src/components/Button.tsx')"),
  format: PatchFormatSchema
    .default("diff")
    .describe("Output format: 'diff' (git diff), 'jsx' (inline comments), 'css' (CSS patch), 'json' (structured change list)"),
}).strict();

type Input = z.infer<typeof InputSchema>;

export function registerGenerateSyncPatch(
  server: McpServer,
  figma: FigmaService,
  renderer: RendererService,
  differ: DiffEngine,
  patcher: PatchGenerator
): void {
  server.registerTool(
    "generate_sync_patch",
    {
      title: "Generate Sync Patch",
      description: `Generate a targeted patch to fix parity mismatches between Figma design and live code.

This tool first runs a parity check (same as check_component_parity), then generates the minimum set of changes required to close the gap. It does NOT rewrite the component — it produces surgical fixes only: the specific props, token substitutions, and missing state implementations that are wrong.

Output formats:
- "diff": Standard git diff format, ready to apply with git apply
- "jsx": Inline JSX comments showing what to change where
- "css": CSS block with corrected properties and inline comments
- "json": Structured list of changes for programmatic use

Args:
  - file_id (string): Figma file ID
  - node_id (string): Figma node ID of the component
  - component_url (string): URL where the component renders
  - css_selector (string): CSS selector for the component root
  - code_path (string): Path to the component source file
  - format ("diff"|"jsx"|"css"|"json"): Output format (default: "diff")

Returns:
  {
    "parityScoreBefore": number,
    "estimatedScoreAfter": number,
    "changes": [
      { "type": "replace"|"add"|"remove", "property": string, "from": string, "to": string, "location": string }
    ],
    "patch": string  // The actual patch content in the requested format
  }

Use when: check_component_parity returned mismatches and you want to fix them.
Don't use when: You want to rewrite the full component — this is a targeted patch only.`,
      inputSchema: InputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (params: Input) => {
      try {
        const [spec, rendered] = await Promise.all([
          figma.getNodeSpec(params.file_id, params.node_id),
          renderer.getComputedStyles(params.component_url, params.css_selector),
        ]);

        const report = differ.diff(spec, rendered, params.code_path);

        if (report.score === 100) {
          return {
            content: [{
              type: "text",
              text: `✅ Score is already 100/100 — no patch needed. Component is in full parity with design.`,
            }],
          };
        }

        const patch = await patcher.generatePatch(report, params.format);
        const text = formatPatchOutput(patch, params.format);

        return {
          content: [{ type: "text", text: text.slice(0, MAX_RESPONSE_CHARS) }],
          structuredContent: JSON.parse(JSON.stringify(patch)) as Record<string, unknown>,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{
            type: "text",
            text: `Error generating patch: ${message}\n\nEnsure the component_url is reachable and the Figma API key is set.`,
          }],
          isError: true,
        };
      }
    }
  );
}

function formatPatchOutput(patch: SyncPatch, format: string): string {
  const lines: string[] = [
    `# Sync Patch: ${patch.codePath}`,
    `Score before: **${patch.parityScoreBefore}/100** → estimated after: **${patch.estimatedScoreAfter}/100**`,
    `Changes: ${patch.changes.length} · Format: ${format}`,
    "",
    "## Changes",
    "",
    ...patch.changes.map(c =>
      `- **${c.type}** \`${c.property}\`: \`${c.from}\` → \`${c.to}\`${c.location ? ` (${c.location})` : ""}`
    ),
    "",
    `## Patch`,
    "",
    "```",
    patch.patch,
    "```",
    "",
    `> After applying, re-run \`check_component_parity\` to verify the score improved.`,
  ];

  return lines.join("\n");
}
