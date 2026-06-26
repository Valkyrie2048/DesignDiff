/**
 * Source Scanner — AST-level analysis of component source files.
 *
 * Solves the core limitation of computed-style verification:
 * `var(--brand-blue)` and `#2563EB` resolve identically in the browser.
 * This scanner reads the SOURCE to detect hardcoded values that should be tokens,
 * giving us "Source Compliance" as a distinct verification dimension from "Visual Fidelity".
 */

import { readFile } from "fs/promises";
import { existsSync } from "fs";

export interface SourceViolation {
  type: "hardcoded-color" | "hardcoded-spacing" | "hardcoded-font-size" | "hardcoded-font-weight";
  value: string;           // The raw hardcoded value found in source
  suggestedToken?: string; // e.g. "var(--brand-blue-600)"
  line: number;
  column: number;
  context: string;         // The line of source for context
  confidence: "verified" | "likely" | "unable-to-verify";
}

export interface SourceScanResult {
  filePath: string;
  violations: SourceViolation[];
  tokenUsageFound: string[];   // CSS custom properties found being used
  sourceCompliance: number;    // 0–100 score
  canScan: boolean;            // false if file not found / unsupported type
  scanMethod: "ast" | "regex" | "unsupported";
}

// Hex colors — 3 or 6 digit, case-insensitive
const HEX_COLOR_RE = /#([0-9A-Fa-f]{6}|[0-9A-Fa-f]{3})\b/g;
// rgb/rgba values
const RGB_RE = /rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+(?:\s*,\s*[\d.]+)?\s*\)/g;
// hsl/hsla
const HSL_RE = /hsla?\(\s*\d+\s*,\s*[\d.]+%\s*,\s*[\d.]+%(?:\s*,\s*[\d.]+)?\s*\)/g;
// CSS custom property usage
const CSS_VAR_RE = /var\(--[\w-]+\)/g;
// Hardcoded pixel spacing that looks suspicious (not 0, 1, 2, 100%)
const SUSPICIOUS_PX_RE = /\b(padding|margin|gap|font-size|border-radius)\s*:\s*([\d.]+px)/g;

// Colors that are almost certainly intentional and not token violations
const WHITELIST_COLORS = new Set([
  "#fff", "#ffffff", "#000", "#000000",
  "#transparent", "transparent",
  "inherit", "currentcolor", "currentColor",
]);

// File types we can scan
const SCANNABLE_EXTENSIONS = new Set([
  ".tsx", ".ts", ".jsx", ".js",
  ".css", ".scss", ".module.css", ".module.scss",
  ".styled.ts", ".styled.tsx",
]);

export class SourceScanner {
  /**
   * Scan a source file for hardcoded values that should be design tokens.
   * Returns violations with line numbers and confidence levels.
   */
  async scan(
    filePath: string,
    tokenMap?: Record<string, string>  // hex -> token name mapping from Figma
  ): Promise<SourceScanResult> {
    if (!filePath || !existsSync(filePath)) {
      return this.emptyResult(filePath, false);
    }

    const ext = this.getExtension(filePath);
    if (!SCANNABLE_EXTENSIONS.has(ext)) {
      return this.emptyResult(filePath, false, "unsupported");
    }

    const source = await readFile(filePath, "utf-8");
    return this.scanSource(source, filePath, tokenMap);
  }

  scanSource(
    source: string,
    filePath: string,
    tokenMap?: Record<string, string>
  ): SourceScanResult {
    const lines = source.split("\n");
    const violations: SourceViolation[] = [];
    const tokenUsageFound: string[] = [];

    // First pass: find all CSS variable usages (so we know what's already using tokens)
    for (const line of lines) {
      const vars = line.match(CSS_VAR_RE) ?? [];
      tokenUsageFound.push(...vars);
    }

    // Second pass: find hardcoded color values
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // Skip comments
      if (line.trim().startsWith("//") || line.trim().startsWith("*") || line.trim().startsWith("/*")) continue;
      // Skip import statements
      if (line.trim().startsWith("import ")) continue;

      // Scan for hex colors
      let match: RegExpExecArray | null;
      const hexRe = new RegExp(HEX_COLOR_RE.source, "gi");
      while ((match = hexRe.exec(line)) !== null) {
        const value = match[0].toLowerCase();
        if (WHITELIST_COLORS.has(value)) continue;
        // Skip if it's in a string that looks like a Figma ID or key
        if (line.includes("figma") || line.includes("fileId") || line.includes("nodeId")) continue;

        const suggested = tokenMap?.[value];
        violations.push({
          type: "hardcoded-color",
          value: match[0],
          suggestedToken: suggested ? `var(--${suggested})` : undefined,
          line: lineNum,
          column: match.index + 1,
          context: line.trim(),
          confidence: suggested ? "verified" : "likely",
        });
      }

      // Scan for rgb/rgba
      const rgbRe = new RegExp(RGB_RE.source, "g");
      while ((match = rgbRe.exec(line)) !== null) {
        violations.push({
          type: "hardcoded-color",
          value: match[0],
          line: lineNum,
          column: match.index + 1,
          context: line.trim(),
          confidence: "likely",
        });
      }

      // Scan for suspicious hardcoded spacing/sizing
      const pxRe = new RegExp(SUSPICIOUS_PX_RE.source, "g");
      while ((match = pxRe.exec(line)) !== null) {
        const prop = match[1];
        const val = match[2];
        const px = parseFloat(val);
        // Only flag values that look like they came from a design spec (multiples of 4 or 8)
        if (px > 2 && (px % 4 === 0 || px % 8 === 0)) {
          violations.push({
            type: prop === "font-size" ? "hardcoded-font-size" :
                  prop === "font-weight" ? "hardcoded-font-weight" : "hardcoded-spacing",
            value: `${prop}: ${val}`,
            line: lineNum,
            column: match.index + 1,
            context: line.trim(),
            confidence: "likely",
          });
        }
      }
    }

    const compliance = this.computeCompliance(violations, tokenUsageFound.length, lines.length);

    return {
      filePath,
      violations,
      tokenUsageFound: [...new Set(tokenUsageFound)],
      sourceCompliance: compliance,
      canScan: true,
      scanMethod: "regex",
    };
  }

  /**
   * Build a token lookup map from Figma spec tokens.
   * Maps resolved hex values to token names so we can suggest the right var().
   */
  buildTokenMap(tokens: Record<string, { raw: string; token?: string }>): Record<string, string> {
    const map: Record<string, string> = {};
    for (const [, val] of Object.entries(tokens)) {
      if (val.token && val.raw) {
        map[val.raw.toLowerCase()] = val.token;
      }
    }
    return map;
  }

  /**
   * Generate a source-level patch: find exact line numbers and produce a true unified diff.
   */
  generateUnifiedDiff(
    source: string,
    filePath: string,
    replacements: Array<{ from: string; to: string; property: string }>
  ): string {
    const lines = source.split("\n");
    const hunks: string[] = [];

    for (const replacement of replacements) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.includes(replacement.from)) continue;

        const lineNum = i + 1;
        // Context: 3 lines before and after
        const contextStart = Math.max(0, i - 3);
        const contextEnd = Math.min(lines.length - 1, i + 3);

        const hunkLines: string[] = [
          `@@ -${lineNum},${contextEnd - contextStart + 1} +${lineNum},${contextEnd - contextStart + 1} @@`,
        ];

        for (let j = contextStart; j <= contextEnd; j++) {
          if (j === i) {
            hunkLines.push(`-${lines[j]}`);
            hunkLines.push(`+${lines[j].replace(replacement.from, replacement.to)}`);
          } else {
            hunkLines.push(` ${lines[j]}`);
          }
        }

        hunks.push(hunkLines.join("\n"));
        break; // First occurrence only — agent re-runs for multiple
      }
    }

    if (hunks.length === 0) {
      return `--- a/${filePath}\n+++ b/${filePath}\n// No exact matches found in source — values may be set via CSS class or computed at runtime.`;
    }

    return [
      `--- a/${filePath}`,
      `+++ b/${filePath}`,
      ...hunks,
    ].join("\n");
  }

  private computeCompliance(
    violations: SourceViolation[],
    tokenUsageCount: number,
    lineCount: number
  ): number {
    if (violations.length === 0) return 100;

    const colorViolations = violations.filter(v => v.type === "hardcoded-color").length;
    const spacingViolations = violations.filter(v => v.type === "hardcoded-spacing").length;

    // Heavier penalty for color violations (break design system contract)
    const penalty = (colorViolations * 15) + (spacingViolations * 8);
    return Math.max(0, Math.round(100 - penalty));
  }

  private getExtension(filePath: string): string {
    // Handle .module.css, .module.scss, .styled.ts etc.
    const parts = filePath.split("/").pop()?.split(".") ?? [];
    if (parts.length > 2) {
      return "." + parts.slice(1).join(".");
    }
    return "." + (parts[1] ?? "");
  }

  private emptyResult(
    filePath: string,
    canScan: boolean,
    scanMethod: SourceScanResult["scanMethod"] = "regex"
  ): SourceScanResult {
    return {
      filePath,
      violations: [],
      tokenUsageFound: [],
      sourceCompliance: canScan ? 100 : -1,
      canScan,
      scanMethod,
    };
  }
}
