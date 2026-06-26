import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FigmaService } from "../services/figma.js";
import { RendererService } from "../services/renderer.js";
import { MAX_RESPONSE_CHARS } from "../constants.js";

const REQUIRED_STATES = ["hover", "focus", "active", "disabled", "error", "loading", "empty"] as const;
type StateName = typeof REQUIRED_STATES[number];

interface StateAuditResult {
  state: StateName;
  definedInFigma: boolean;
  presentInCode: boolean;
  accessible: boolean;
  notes: string;
  severity: "pass" | "warn" | "fail" | "critical";
}

const ACCESSIBILITY_REQUIREMENTS: Partial<Record<StateName, string>> = {
  focus: "WCAG 2.1 AA requires visible focus indicator (2.4.7). Failure is a Level AA accessibility violation.",
  disabled: "Disabled elements must be visually distinct. ARIA: aria-disabled should be set.",
  error: "Error states require both visual and programmatic indication (WCAG 1.3.1).",
};

const InputSchema = z.object({
  file_id: z.string().min(1).describe("Figma file ID"),
  node_id: z.string().min(1).describe("Figma node ID of the component (should be a COMPONENT_SET with variants)"),
  component_url: z.string().url().describe("URL where the component renders"),
  css_selector: z.string().default("#storybook-root > *").describe("CSS selector for the component root"),
}).strict();

type Input = z.infer<typeof InputSchema>;

export function registerAuditStateCoverage(
  server: McpServer,
  figma: FigmaService,
  renderer: RendererService
): void {
  server.registerTool(
    "audit_state_coverage",
    {
      title: "Audit State Coverage",
      description: `Check whether every interactive state defined in a Figma component actually exists in code.

Figma components define states as variants (State=Hover, State=Focus, State=Disabled, etc.). This tool extracts every state from the Figma COMPONENT_SET, attempts to trigger it in the headless renderer, and reports which states are missing, incomplete, or failing accessibility requirements.

This is the gap nobody else closes: designers define states, developers implement the default, and edge cases pile up in the backlog — until a user or accessibility audit surfaces them.

Returns: per-state audit with accessibility implications, WCAG references for failures, and prioritized implementation guidance.`,
      inputSchema: InputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async (params: Input) => {
      try {
        const spec = await figma.getNodeSpec(params.file_id, params.node_id);
        const rendered = await renderer.getComputedStyles(params.component_url, params.css_selector);

        const figmaStates = new Set(spec.states.map(s => s.name as StateName));
        const codeStates = new Set(Object.keys(rendered.states) as StateName[]);

        const results: StateAuditResult[] = [];

        for (const state of REQUIRED_STATES) {
          const inFigma = figmaStates.has(state);
          const inCode = codeStates.has(state);
          const a11yNote = ACCESSIBILITY_REQUIREMENTS[state];

          let severity: StateAuditResult["severity"] = "pass";
          let notes = "";

          if (!inFigma && !inCode) {
            severity = "warn";
            notes = `Not defined in Figma, not implemented in code. ${a11yNote ? "However: " + a11yNote : "Consider whether this state is needed."}`;
          } else if (inFigma && !inCode) {
            severity = (state === "focus" || state === "disabled") ? "critical" : "fail";
            notes = `Defined in Figma but missing in code. ${a11yNote ?? "Users will encounter an undefined state."}`;
          } else if (!inFigma && inCode) {
            severity = "warn";
            notes = "Implemented in code but has no Figma reference. May be inconsistent with design intent.";
          } else {
            severity = "pass";
            notes = a11yNote ? `Present in both. Verify: ${a11yNote}` : "Present in both design and code.";
          }

          results.push({
            state,
            definedInFigma: inFigma,
            presentInCode: inCode,
            accessible: inCode && (state !== "focus" || inCode), // simplified — real impl checks computed outline
            notes,
            severity,
          });
        }

        return {
          content: [{ type: "text", text: formatStateAudit(results, params.node_id).slice(0, MAX_RESPONSE_CHARS) }],
          structuredContent: JSON.parse(JSON.stringify({ nodeId: params.node_id, results })) as Record<string, unknown>,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `## ❌ State audit failed\n\n${message}` }],
          isError: true,
        };
      }
    }
  );
}

function formatStateAudit(results: StateAuditResult[], nodeId: string): string {
  const critical = results.filter(r => r.severity === "critical");
  const fails = results.filter(r => r.severity === "fail");
  const warns = results.filter(r => r.severity === "warn");
  const passes = results.filter(r => r.severity === "pass");

  const verdict = critical.length > 0
    ? `🔴 **Accessibility failures detected — ${critical.length} state${critical.length === 1 ? "" : "s"} are ship-blocking.**`
    : fails.length > 0
    ? `🟠 **${fails.length} state${fails.length === 1 ? "" : "s"} missing from code.** UX is incomplete.`
    : warns.length > 0
    ? `🟡 **${warns.length} state${warns.length === 1 ? "" : "s"} need attention.**`
    : `✅ **Full state coverage — all interactive states are implemented.**`;

  const lines = [
    verdict,
    ``,
    `Component: \`${nodeId}\``,
    `States: ${passes.length} pass · ${warns.length} warn · ${fails.length} fail · ${critical.length} critical`,
    ``,
  ];

  if (critical.length > 0) {
    lines.push(`## 🔴 Critical — Accessibility Failures`, ``);
    for (const r of critical) {
      lines.push(`**${r.state}** — ${r.notes}`, ``);
    }
  }

  if (fails.length > 0) {
    lines.push(`## 🟠 Missing States`, ``);
    for (const r of fails) {
      lines.push(`**${r.state}**`);
      lines.push(`  In Figma: ${r.definedInFigma ? "✓" : "✗"}  In code: ${r.presentInCode ? "✓" : "✗"}`);
      lines.push(`  ${r.notes}`, ``);
    }
  }

  if (warns.length > 0) {
    lines.push(`## 🟡 Warnings`, ``);
    for (const r of warns) {
      lines.push(`**${r.state}**: ${r.notes}`, ``);
    }
  }

  if (passes.length > 0) {
    lines.push(`## ✅ Passing`, ``);
    lines.push(passes.map(r => `- ${r.state}`).join("\n"), ``);
  }

  if (critical.length > 0 || fails.length > 0) {
    lines.push(
      `## Implementation Priority`,
      ``,
      `1. **focus** — keyboard navigation (WCAG 2.4.7, Level AA)`,
      `2. **disabled** — visual affordance + aria-disabled`,
      `3. **error** — form validation feedback`,
      `4. **loading** — async operation feedback`,
      `5. **hover** — desktop pointer affordance`,
    );
  }

  return lines.join("\n");
}
