/**
 * Intelligence layer — enriches raw mismatches with context, consequences,
 * and actionable narrative. This is what turns a linter into a senior engineer.
 */

import type { ParityMismatch, ParityReport } from "../types.js";

export interface EnrichedMismatch extends ParityMismatch {
  consequence: string;       // What breaks in production if this isn't fixed
  effort: "trivial" | "easy" | "moderate" | "complex";
  autoFixable: boolean;
  priority: number;          // 1 = fix first
}

export interface ParityNarrative {
  headline: string;          // One-sentence verdict
  summary: string;           // 2-3 sentence engineer-voice summary
  topPriority: EnrichedMismatch | null;
  quickWins: EnrichedMismatch[];
  requiresDesigner: EnrichedMismatch[];
  estimatedFixTime: string;
  riskLevel: "low" | "medium" | "high" | "critical";
  patternDetected: string | null;  // e.g. "token avoidance pattern" or "copy-paste drift"
}

const CONSEQUENCE_MAP: Record<string, Record<string, string>> = {
  token: {
    "background-color": "Dark mode will show the wrong color. Brand updates won't propagate. Design system governance is bypassed — every future token change will miss this component.",
    "color": "Text color won't update when the design token changes. Accessibility contrast ratios may drift undetected across themes.",
    "border-color": "Border won't respect theme changes. Any brand refresh will leave this component visually inconsistent.",
    default: "This hardcoded value bypasses your design system. Token updates won't reach this component.",
  },
  spacing: {
    "padding-top": "Component will feel cramped or bloated compared to adjacent components. Touch targets may fall below 44px minimum on mobile.",
    "padding-bottom": "Vertical rhythm breaks. Components stacked below this one will appear misaligned.",
    "padding-left": "Text will feel either clipped or floating. Horizontal alignment with sibling elements breaks.",
    "padding-right": "Content may overflow or have inconsistent gutters in constrained layouts.",
    default: "Visual rhythm breaks. The component will feel subtly wrong next to correctly-spaced siblings — the kind of thing users notice without knowing why.",
  },
  state: {
    "hover state": "Users get no visual feedback on hover. Feels broken on desktop. Fails WCAG 2.1 guideline 1.4.1 (use of color).",
    "focus state": "Keyboard navigation is broken. This is a WCAG 2.1 Level AA failure (guideline 2.4.7). Accessibility audit will flag this.",
    "disabled state": "Disabled elements look interactive. Users will try to click them, get confused, and assume the UI is broken.",
    "error state": "Form errors won't be visually communicated. Users won't know what went wrong.",
    "loading state": "No loading feedback. Users will double-click, resubmit forms, or abandon — mistaking latency for failure.",
    default: "This interactive state is invisible in code. Users encounter an undefined experience.",
  },
  color: {
    default: "Color mismatch between design and implementation. May affect brand perception, accessibility contrast ratios, or theme consistency.",
  },
  typography: {
    "font-size": "Text hierarchy breaks. If this is a heading, it loses its visual weight relative to body copy.",
    "font-weight": "Visual emphasis is wrong. Bold text that renders as regular weight loses its signaling function entirely.",
    default: "Typography doesn't match design intent. Text hierarchy and readability may be affected.",
  },
  border: {
    default: "Border inconsistency. Component will look subtly different from its Figma counterpart — especially visible in dense UI.",
  },
};

const PATTERN_DETECTORS = [
  {
    name: "Token avoidance pattern",
    description: "Multiple hardcoded color values where tokens exist. Developer may not have had access to the token mapping, or used a color picker on the Figma file instead of inspecting the variable.",
    detect: (mismatches: ParityMismatch[]) =>
      mismatches.filter(m => m.category === "token").length >= 2,
  },
  {
    name: "Copy-paste drift",
    description: "Spacing values are off by a consistent amount (likely copied from a similar component and not updated). Check if padding values are all shifted by the same delta.",
    detect: (mismatches: ParityMismatch[]) => {
      const spacingMismatches = mismatches.filter(m => m.category === "spacing");
      if (spacingMismatches.length < 2) return false;
      const deltas = spacingMismatches.map(m => {
        const design = parseFloat(m.designValue);
        const code = parseFloat(m.codeValue);
        return isNaN(design) || isNaN(code) ? null : design - code;
      }).filter((d): d is number => d !== null);
      if (deltas.length < 2) return false;
      return deltas.every(d => Math.abs(d - deltas[0]) < 1);
    },
  },
  {
    name: "State implementation gap",
    description: "Multiple interactive states are missing. This often happens when a developer implements the default state only and defers states to 'later' — which never comes.",
    detect: (mismatches: ParityMismatch[]) =>
      mismatches.filter(m => m.category === "state").length >= 2,
  },
  {
    name: "AI-generated code signature",
    description: "The combination of correct structure with wrong token usage and missing states is characteristic of AI-generated code. The agent likely generated correct layout from the Figma spec but didn't have access to the token file.",
    detect: (mismatches: ParityMismatch[]) => {
      const hasTokenIssues = mismatches.some(m => m.category === "token");
      const hasMissingStates = mismatches.some(m => m.category === "state");
      const hasNoStructuralIssues = !mismatches.some(m =>
        m.category === "spacing" && m.severity === "critical"
      );
      return hasTokenIssues && hasMissingStates && hasNoStructuralIssues;
    },
  },
];

function getConsequence(mismatch: ParityMismatch): string {
  const categoryMap = CONSEQUENCE_MAP[mismatch.category];
  if (!categoryMap) return "This mismatch will cause visual inconsistency between design and implementation.";
  return categoryMap[mismatch.property] ?? categoryMap.default ?? categoryMap[Object.keys(categoryMap)[0]];
}

function getEffort(mismatch: ParityMismatch): EnrichedMismatch["effort"] {
  if (mismatch.category === "state" && mismatch.codeValue === "missing") return "moderate";
  if (mismatch.category === "token") return "trivial"; // just swap value for var()
  if (mismatch.category === "spacing") return "trivial";
  if (mismatch.category === "typography") return "trivial";
  if (mismatch.category === "border") return "trivial";
  return "easy";
}

function getPriority(mismatch: ParityMismatch): number {
  // Lower = more urgent
  const severityBase = mismatch.severity === "critical" ? 0 : mismatch.severity === "warning" ? 10 : 20;
  const categoryBoost: Record<string, number> = {
    token: 0,    // token violations break entire design system
    state: 2,    // missing states break UX
    color: 3,
    spacing: 5,
    typography: 6,
    border: 8,
  };
  return severityBase + (categoryBoost[mismatch.category] ?? 10);
}

function getRiskLevel(report: ParityReport): ParityNarrative["riskLevel"] {
  const hasCritical = report.mismatches.some(m => m.severity === "critical");
  const hasAccessibilityIssue = report.mismatches.some(m =>
    m.property.includes("focus") || m.property.includes("disabled")
  );
  if (hasAccessibilityIssue) return "critical";
  if (hasCritical && report.score < 50) return "high";
  if (hasCritical) return "medium";
  return "low";
}

function getEstimatedFixTime(enriched: EnrichedMismatch[]): string {
  const autoFixable = enriched.filter(e => e.autoFixable).length;
  const manual = enriched.filter(e => !e.autoFixable);
  const manualTime = manual.reduce((acc, m) => {
    return acc + (m.effort === "trivial" ? 2 : m.effort === "easy" ? 5 : m.effort === "moderate" ? 20 : 60);
  }, 0);

  if (autoFixable > 0 && manual.length === 0) return `~1 min (all ${autoFixable} fixes auto-patchable)`;
  if (autoFixable > 0) return `~${Math.round(manualTime)} min manual work + auto-patch for ${autoFixable} issues`;
  return `~${Math.round(manualTime)} min`;
}

function generateHeadline(report: ParityReport, riskLevel: ParityNarrative["riskLevel"]): string {
  if (report.score === 100) return "Perfect parity — design and code are fully aligned.";
  if (report.score >= 95) return `Near-perfect at ${report.score}/100 — one minor issue to resolve.`;

  const tokenViolations = report.mismatches.filter(m => m.category === "token").length;
  const missingStates = report.mismatches.filter(m => m.category === "state").length;
  const spacingIssues = report.mismatches.filter(m => m.category === "spacing").length;

  if (riskLevel === "critical") return `Score ${report.score}/100 — accessibility failure detected, ship-blocking.`;
  if (tokenViolations >= 2) return `Score ${report.score}/100 — design system contract broken: ${tokenViolations} hardcoded values bypassing tokens.`;
  if (missingStates >= 2) return `Score ${report.score}/100 — ${missingStates} interactive states missing, UX is incomplete.`;
  if (spacingIssues >= 3) return `Score ${report.score}/100 — systematic spacing drift detected, likely copy-paste from another component.`;
  return `Score ${report.score}/100 — ${report.mismatches.length} issue${report.mismatches.length === 1 ? "" : "s"} found, ${report.mismatches.filter(m => m.severity === "critical").length} critical.`;
}

function generateSummary(report: ParityReport, enriched: EnrichedMismatch[], pattern: string | null): string {
  const parts: string[] = [];

  const autoFixCount = enriched.filter(e => e.autoFixable).length;
  const manualCount = enriched.filter(e => !e.autoFixable).length;

  if (autoFixCount > 0 && manualCount === 0) {
    parts.push(`All ${autoFixCount} issue${autoFixCount === 1 ? "" : "s"} are auto-patchable — run \`generate_sync_patch\` to resolve them in one step.`);
  } else if (autoFixCount > 0) {
    parts.push(`${autoFixCount} issue${autoFixCount === 1 ? "" : "s"} can be auto-patched; ${manualCount} require${manualCount === 1 ? "s" : ""} manual implementation.`);
  } else {
    parts.push(`${manualCount} issue${manualCount === 1 ? "" : "s"} require manual attention — no auto-patch available for state implementations.`);
  }

  if (pattern) {
    parts.push(`Pattern detected: ${pattern}.`);
  }

  const worstMismatch = enriched[0];
  if (worstMismatch && worstMismatch.severity === "critical") {
    parts.push(`Most urgent: ${worstMismatch.property} — ${worstMismatch.consequence}`);
  }

  return parts.join(" ");
}

export function buildNarrative(report: ParityReport): ParityNarrative {
  // Enrich mismatches
  const enriched: EnrichedMismatch[] = report.mismatches
    .map(m => ({
      ...m,
      consequence: getConsequence(m),
      effort: getEffort(m),
      autoFixable: m.category !== "state",
      priority: getPriority(m),
    }))
    .sort((a, b) => a.priority - b.priority);

  // Detect patterns
  const detectedPattern = PATTERN_DETECTORS.find(p => p.detect(report.mismatches));

  // Categorize
  const quickWins = enriched.filter(e => e.autoFixable && e.effort === "trivial");
  const requiresDesigner = enriched.filter(e => e.category === "state" && e.codeValue === "missing");

  const riskLevel = getRiskLevel(report);

  return {
    headline: generateHeadline(report, riskLevel),
    summary: generateSummary(report, enriched, detectedPattern?.name ?? null),
    topPriority: enriched[0] ?? null,
    quickWins,
    requiresDesigner,
    estimatedFixTime: getEstimatedFixTime(enriched),
    riskLevel,
    patternDetected: detectedPattern
      ? `${detectedPattern.name}: ${detectedPattern.description}`
      : null,
  };
}
