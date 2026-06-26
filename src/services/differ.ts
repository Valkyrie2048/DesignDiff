import type {
  FigmaNodeSpec, RenderedStyles, ParityReport, ParityMismatch, CategoryScore
} from "../types.js";
import { GRADE_THRESHOLDS, SEVERITY_WEIGHTS } from "../constants.js";

export class DiffEngine {
  diff(spec: FigmaNodeSpec, rendered: RenderedStyles, codePath: string): ParityReport {
    // Gather mismatches — deduplication map prevents double-counting same property
    const seen = new Set<string>();
    const mismatches: ParityMismatch[] = [];

    const add = (m: ParityMismatch) => {
      const key = `${m.category}::${m.property}`;
      if (seen.has(key)) return; // BUG FIX: prevent double-count between diffColors + diffTokenUsage
      seen.add(key);
      mismatches.push(m);
    };

    for (const m of this.diffSpacing(spec, rendered)) add(m);
    for (const m of this.diffColors(spec, rendered)) add(m);
    for (const m of this.diffTypography(spec, rendered)) add(m);
    for (const m of this.diffBorders(spec, rendered)) add(m);
    for (const m of this.diffStates(spec, rendered)) add(m);
    for (const m of this.diffTokenUsage(spec, rendered)) add(m);

    const score = this.computeScore(mismatches);
    const grade = this.computeGrade(score);

    // BUG FIX: patchAvailable is false only for perfect scores or state-only issues
    const hasActionableMismatches = mismatches.some(m => m.category !== "state");

    return {
      nodeId: spec.nodeId,
      codePath,
      score,
      grade,
      patchAvailable: score < 100 && hasActionableMismatches,
      mismatches,
      categories: {
        spacing: this.buildCategory(mismatches, "spacing"),
        color: this.buildCategory(mismatches, "color"),
        typography: this.buildCategory(mismatches, "typography"),
        border: this.buildCategory(mismatches, "border"),
        states: this.buildCategory(mismatches, "state"),
        tokens: this.buildCategory(mismatches, "token"),
      },
      checkedAt: new Date().toISOString(),
    };
  }

  private diffSpacing(spec: FigmaNodeSpec, rendered: RenderedStyles): ParityMismatch[] {
    const mismatches: ParityMismatch[] = [];
    const { spacing } = spec;
    const { computed } = rendered;

    if (spacing.padding) {
      const checks: Array<[string, number, string | undefined]> = [
        ["padding-top", spacing.padding.top, computed["padding-top"]],
        ["padding-right", spacing.padding.right, computed["padding-right"]],
        ["padding-bottom", spacing.padding.bottom, computed["padding-bottom"]],
        ["padding-left", spacing.padding.left, computed["padding-left"]],
      ];
      for (const [prop, designPx, renderedVal] of checks) {
        const renderedPx = parseFloat(renderedVal ?? "0");
        if (Math.abs(designPx - renderedPx) > 1) {
          mismatches.push({
            property: prop,
            designValue: `${designPx}px`,
            codeValue: renderedVal ?? "0px",
            severity: Math.abs(designPx - renderedPx) > 4 ? "critical" : "warning",
            category: "spacing",
            fix: `Change ${prop} from ${renderedVal ?? "0px"} to ${designPx}px`,
          });
        }
      }
    }

    if (spacing.borderRadius !== undefined) {
      const renderedRadius = parseFloat(computed["border-radius"] ?? "0");
      if (Math.abs(Number(spacing.borderRadius) - renderedRadius) > 1) {
        mismatches.push({
          property: "border-radius",
          designValue: `${spacing.borderRadius}px`,
          codeValue: computed["border-radius"] ?? "0px",
          severity: "warning",
          category: "spacing",
          fix: `Set border-radius to ${spacing.borderRadius}px`,
        });
      }
    }

    return mismatches;
  }

  private diffColors(spec: FigmaNodeSpec, rendered: RenderedStyles): ParityMismatch[] {
    const mismatches: ParityMismatch[] = [];
    const bgToken = spec.tokens.background;
    if (!bgToken) return mismatches;

    const renderedBg = rendered.computed["background-color"];
    const renderedHex = this.cssColorToHex(renderedBg); // BUG FIX: handles rgba()

    if (renderedHex && !this.colorsMatch(bgToken.raw, renderedHex)) {
      mismatches.push({
        property: "background-color",
        designValue: bgToken.token ? `token(${bgToken.token}) = ${bgToken.raw}` : bgToken.raw,
        codeValue: renderedBg,
        severity: "critical",
        category: "color",
        fix: bgToken.token
          ? `Use var(--${bgToken.token}) instead of ${renderedBg}`
          : `Set background-color to ${bgToken.raw}`,
      });
    }

    return mismatches;
  }

  private diffTypography(spec: FigmaNodeSpec, rendered: RenderedStyles): ParityMismatch[] {
    const mismatches: ParityMismatch[] = [];
    if (!spec.typography) return mismatches;

    const { typography } = spec;
    const { computed } = rendered;

    const fontSizeRendered = parseFloat(computed["font-size"] ?? "0");
    if (Math.abs(typography.fontSize - fontSizeRendered) > 0.5) {
      mismatches.push({
        property: "font-size",
        designValue: `${typography.fontSize}px`,
        codeValue: computed["font-size"] ?? "unknown",
        severity: "warning",
        category: "typography",
        fix: `Set font-size to ${typography.fontSize}px`,
      });
    }

    const fontWeightRendered = parseInt(computed["font-weight"] ?? "400");
    if (typography.fontWeight !== fontWeightRendered) {
      mismatches.push({
        property: "font-weight",
        designValue: String(typography.fontWeight),
        codeValue: computed["font-weight"] ?? "unknown",
        severity: "warning",
        category: "typography",
        fix: `Set font-weight to ${typography.fontWeight}`,
      });
    }

    return mismatches;
  }

  private diffBorders(spec: FigmaNodeSpec, rendered: RenderedStyles): ParityMismatch[] {
    const mismatches: ParityMismatch[] = [];
    if (!spec.borders) return mismatches;

    const renderedBorderWidth = parseFloat(rendered.computed["border-width"] ?? "0");
    if (Math.abs(spec.borders.width - renderedBorderWidth) > 0.5) {
      mismatches.push({
        property: "border-width",
        designValue: `${spec.borders.width}px`,
        codeValue: rendered.computed["border-width"] ?? "0px",
        severity: "warning",
        category: "border",
        fix: `Set border-width to ${spec.borders.width}px`,
      });
    }

    return mismatches;
  }

  private diffStates(spec: FigmaNodeSpec, rendered: RenderedStyles): ParityMismatch[] {
    return spec.states
      .filter(state => !rendered.states[state.name])
      .map(state => ({
        property: `${state.name} state`,
        designValue: "defined in Figma",
        codeValue: "missing",
        severity: (state.name === "disabled" || state.name === "focus")
          ? "critical" as const
          : "warning" as const,
        category: "state" as const,
        fix: `Implement :${state.name} styles — check Figma variant "${state.name}" for exact values`,
      }));
  }

  private diffTokenUsage(spec: FigmaNodeSpec, rendered: RenderedStyles): ParityMismatch[] {
    const mismatches: ParityMismatch[] = [];

    for (const [prop, tokenVal] of Object.entries(spec.tokens)) {
      if (!tokenVal.token) continue;

      const cssProp = this.mapTokenPropToCss(prop);
      const renderedVal = rendered.computed[cssProp];
      if (!renderedVal) continue;

      // BUG FIX: computed values are never CSS vars — browsers always resolve them.
      // So we check if the resolved value MATCHES the token's resolved value.
      // If it doesn't, either wrong value OR correct value but no token used in source.
      const renderedHex = this.cssColorToHex(renderedVal);
      const tokenHex = this.cssColorToHex(tokenVal.raw);

      if (renderedHex && tokenHex && this.colorsMatch(renderedHex, tokenHex)) {
        // Values match — but was a token used? We can't tell from computed styles.
        // Don't flag as mismatch; it renders correctly. The token-vs-hardcode
        // issue is a source code concern, not a rendered output concern.
        continue;
      }

      // Values don't match — flag as token mismatch (value is wrong, likely no token)
      if (renderedHex && tokenHex && !this.colorsMatch(renderedHex, tokenHex)) {
        mismatches.push({
          property: `${prop} (token)`,
          designValue: `var(--${tokenVal.token}) = ${tokenVal.raw}`,
          codeValue: renderedVal,
          severity: "critical",
          category: "token",
          fix: `Set ${cssProp} to var(--${tokenVal.token})`,
        });
      }
    }

    return mismatches;
  }

  private computeScore(mismatches: ParityMismatch[]): number {
    if (mismatches.length === 0) return 100;
    let penalty = 0;
    for (const m of mismatches) {
      const weight = SEVERITY_WEIGHTS[m.category] ?? 10;
      const mult = m.severity === "critical" ? 1.5 : m.severity === "warning" ? 1.0 : 0.5;
      penalty += weight * mult;
    }
    return Math.max(0, Math.round(100 - penalty));
  }

  private computeGrade(score: number): "A" | "B" | "C" | "D" | "F" {
    if (score >= GRADE_THRESHOLDS.A) return "A";
    if (score >= GRADE_THRESHOLDS.B) return "B";
    if (score >= GRADE_THRESHOLDS.C) return "C";
    if (score >= GRADE_THRESHOLDS.D) return "D";
    return "F";
  }

  private buildCategory(mismatches: ParityMismatch[], category: ParityMismatch["category"]): CategoryScore {
    const cm = mismatches.filter(m => m.category === category);
    const maxPossible = SEVERITY_WEIGHTS[category] ?? 10;
    const penalty = cm.reduce((acc, m) => {
      return acc + (m.severity === "critical" ? maxPossible : m.severity === "warning" ? maxPossible * 0.6 : maxPossible * 0.2);
    }, 0);
    return {
      score: Math.max(0, Math.round(100 - penalty)),
      passed: cm.length === 0 ? 1 : 0,
      failed: cm.length,
      mismatches: cm,
    };
  }

  /**
   * BUG FIX: handle rgba(), rgb(), hex — browsers always return rgb/rgba from getComputedStyle
   */
  private cssColorToHex(css: string | undefined): string | null {
    if (!css) return null;
    if (css === "transparent" || css === "rgba(0, 0, 0, 0)") return "transparent";

    // rgba(r, g, b, a) — browser standard output
    const rgbaMatch = css.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*[\d.]+)?\)/);
    if (rgbaMatch) {
      const [, r, g, b] = rgbaMatch;
      return `#${parseInt(r).toString(16).padStart(2,"0")}${parseInt(g).toString(16).padStart(2,"0")}${parseInt(b).toString(16).padStart(2,"0")}`;
    }
    return css.startsWith("#") ? css.toLowerCase() : null;
  }

  private colorsMatch(a: string, b: string): boolean {
    return a.toLowerCase() === b.toLowerCase();
  }

  private mapTokenPropToCss(prop: string): string {
    const map: Record<string, string> = {
      background: "background-color",
      color: "color",
      border: "border-color",
    };
    return map[prop] ?? prop;
  }
}
