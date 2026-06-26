import { readFile } from "fs/promises";
import { existsSync } from "fs";
import type { SyncPatch, ParityReport, PatchFormat, PatchChange } from "../types.js";
import { SourceScanner } from "./source-scanner.js";

export class PatchGenerator {
  private scanner = new SourceScanner();

  async generatePatch(report: ParityReport, format: PatchFormat = "diff"): Promise<SyncPatch> {
    let sourceCode = "";
    const fileExists = report.codePath && existsSync(report.codePath);

    if (fileExists) {
      try {
        sourceCode = await readFile(report.codePath, "utf-8");
      } catch {
        sourceCode = "";
      }
    }

    const changes = this.buildChanges(report, sourceCode);
    const estimatedScoreAfter = this.estimateScoreAfterPatch(report, changes);
    const patch = await this.renderPatch(changes, report.codePath, sourceCode, format);

    return {
      nodeId: report.nodeId,
      codePath: report.codePath,
      format,
      parityScoreBefore: report.score,
      estimatedScoreAfter,
      changes,
      patch,
    };
  }

  private buildChanges(report: ParityReport, source: string): PatchChange[] {
    const changes: PatchChange[] = [];

    for (const mismatch of report.mismatches) {
      if (mismatch.category === "state") {
        changes.push({
          type: "add",
          property: mismatch.property,
          from: "missing",
          to: `/* TODO: implement :${mismatch.property.replace(" state", "")} styles per Figma */`,
          location: "end of component styles",
        });
        continue;
      }

      if (mismatch.category === "color" || mismatch.category === "token") {
        const targetVal = this.resolveTargetValue(mismatch.designValue);
        const fromVal = mismatch.codeValue;
        const location = this.findExactLocation(source, fromVal, mismatch.property);

        changes.push({
          type: "replace",
          property: mismatch.property,
          from: fromVal,
          to: targetVal,
          location,
        });
        continue;
      }

      // spacing, typography, border
      const location = this.findExactLocation(source, mismatch.codeValue, mismatch.property);
      changes.push({
        type: "replace",
        property: mismatch.property,
        from: mismatch.codeValue,
        to: mismatch.designValue,
        location,
      });
    }

    return changes;
  }

  private async renderPatch(
    changes: PatchChange[],
    filePath: string,
    source: string,
    format: PatchFormat
  ): Promise<string> {
    switch (format) {
      case "diff": return this.renderUnifiedDiff(changes, filePath, source);
      case "jsx": return this.renderJsx(changes, filePath);
      case "css": return this.renderCss(changes, filePath);
      case "json": return JSON.stringify({ file: filePath, changes }, null, 2);
    }
  }

  /**
   * True unified diff — real line numbers, real context, git apply compatible.
   */
  private renderUnifiedDiff(changes: PatchChange[], filePath: string, source: string): string {
    if (!source) {
      // No source file — produce a descriptive patch that still conveys the changes
      const lines = [
        `--- a/${filePath}`,
        `+++ b/${filePath}`,
        ``,
        `# Source file not found at ${filePath}`,
        `# Apply these changes manually:`,
        ``,
      ];
      for (const change of changes) {
        if (change.type === "replace") {
          lines.push(`@@ ${change.property} @@`);
          lines.push(`-  ${this.toCssProperty(change.property)}: ${change.from};`);
          lines.push(`+  ${this.toCssProperty(change.property)}: ${change.to};`);
          lines.push(``);
        } else if (change.type === "add") {
          lines.push(`+  ${change.to}`);
          lines.push(``);
        }
      }
      return lines.join("\n");
    }

    const sourceLines = source.split("\n");
    const hunks: Array<{ lineNum: number; hunkLines: string[] }> = [];
    const appliedLines = new Set<number>(); // Don't double-patch same line

    for (const change of changes) {
      if (change.type === "add") continue; // State TODOs go at the end

      const lineIndex = this.findLineIndex(sourceLines, change.from, change.property);
      if (lineIndex === -1 || appliedLines.has(lineIndex)) continue;
      appliedLines.add(lineIndex);

      const CONTEXT = 3;
      const contextStart = Math.max(0, lineIndex - CONTEXT);
      const contextEnd = Math.min(sourceLines.length - 1, lineIndex + CONTEXT);
      const hunkSize = contextEnd - contextStart + 1;

      const hunkHeader = `@@ -${contextStart + 1},${hunkSize} +${contextStart + 1},${hunkSize} @@`;
      const hunkLines = [hunkHeader];

      for (let j = contextStart; j <= contextEnd; j++) {
        if (j === lineIndex) {
          hunkLines.push(`-${sourceLines[j]}`);
          hunkLines.push(`+${sourceLines[j].replace(change.from, change.to)}`);
        } else {
          hunkLines.push(` ${sourceLines[j]}`);
        }
      }

      hunks.push({ lineNum: lineIndex, hunkLines });
    }

    // Sort hunks by line number for a clean, readable patch
    hunks.sort((a, b) => a.lineNum - b.lineNum);

    const addChanges = changes.filter(c => c.type === "add");
    const output = [
      `--- a/${filePath}`,
      `+++ b/${filePath}`,
      ...hunks.flatMap(h => [...h.hunkLines, ""]),
    ];

    if (addChanges.length > 0) {
      const lastLine = sourceLines.length;
      output.push(`@@ -${lastLine},0 +${lastLine},${addChanges.length} @@`);
      for (const c of addChanges) {
        output.push(`+${c.to}`);
      }
    }

    if (hunks.length === 0 && addChanges.length === 0) {
      output.push("# No exact string matches found in source.");
      output.push("# Values may be set via CSS class, computed at runtime, or in a separate stylesheet.");
      output.push("# Manual changes required:");
      for (const c of changes) {
        if (c.type === "replace") {
          output.push(`# ${c.property}: ${c.from} → ${c.to}`);
        }
      }
    }

    return output.join("\n");
  }

  private renderJsx(changes: PatchChange[], filePath: string): string {
    const replaces = changes.filter(c => c.type === "replace");
    const adds = changes.filter(c => c.type === "add");

    const styleLines = replaces.map(c => {
      const camel = c.property.replace(/-([a-z])/g, (_, l: string) => l.toUpperCase());
      const cleanProp = camel.replace(/ \(token\)/, "").replace(/ state/, "").trim();
      return `  ${cleanProp}: "${c.to}", // was: "${c.from}"  [${c.location ?? "location unknown"}]`;
    });

    return [
      `// DesignDiff patch — ${filePath}`,
      `// Apply to the component's style prop or styled-component:`,
      ``,
      `const designDiffFixes = {`,
      ...styleLines,
      `};`,
      ``,
      ...(adds.length ? [
        `// States requiring manual implementation:`,
        ...adds.map(c => `// ${c.to}`),
      ] : []),
    ].join("\n");
  }

  private renderCss(changes: PatchChange[], filePath: string): string {
    const replaces = changes.filter(c => c.type === "replace");
    const adds = changes.filter(c => c.type === "add");

    return [
      `/* DesignDiff patch — ${filePath} */`,
      `.component {`,
      ...replaces.map(c => {
        const prop = this.toCssProperty(c.property);
        return `  ${prop}: ${c.to}; /* was: ${c.from}  [${c.location ?? "location unknown"}] */`;
      }),
      `}`,
      ...(adds.length ? [
        ``,
        `/* Missing states — implement these: */`,
        ...adds.map(c => `/* ${c.to} */`),
      ] : []),
    ].join("\n");
  }

  /**
   * Find the exact line index of a value in source — searches both kebab and camelCase.
   */
  private findLineIndex(lines: string[], value: string, property: string): number {
    if (!value || value === "missing" || value === "location unknown") return -1;

    const kebab = property.replace(/([A-Z])/g, "-$1").toLowerCase()
      .replace(/ \(.*\)/, "").replace(/ state/, "").trim();
    const camel = property.replace(/-([a-z])/g, (_, l: string) => l.toUpperCase())
      .replace(/ \(.*\)/, "").replace(/ state/, "").trim();

    // First: find the line containing the actual value
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.includes(value)) {
        return i;
      }
    }

    // Second: find by property name
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.includes(kebab) || line.includes(camel)) {
        return i;
      }
    }

    return -1;
  }

  private findExactLocation(source: string, value: string, property: string): string {
    if (!source || !value || value === "missing") return "location unknown — file not found";
    const lines = source.split("\n");
    const idx = this.findLineIndex(lines, value, property);
    return idx >= 0 ? `line ${idx + 1}` : "location unknown";
  }

  private resolveTargetValue(designValue: string): string {
    // "token(brand-blue) = #2563EB" → "var(--brand-blue)"
    if (designValue.startsWith("token(")) {
      const tokenName = designValue.slice(6, designValue.indexOf(")"));
      return `var(--${tokenName})`;
    }
    // "var(--brand-blue) = #2563EB" → "var(--brand-blue)"
    if (designValue.includes(" = ")) {
      return designValue.split(" = ")[0];
    }
    return designValue;
  }

  private toCssProperty(property: string): string {
    return property
      .replace(/ \(token\)/, "")
      .replace(/ \(.*\)/, "")
      .replace(/ state/, "")
      .trim();
  }

  private estimateScoreAfterPatch(report: ParityReport, changes: PatchChange[]): number {
    const WEIGHTS: Record<string, number> = {
      spacing: 18, color: 20, typography: 15, border: 12, state: 17, token: 18,
    };

    let penaltyRemoved = 0;
    for (const mismatch of report.mismatches) {
      if (mismatch.category === "state") continue;
      const isFixed = changes.some(c => c.property === mismatch.property && c.type === "replace");
      if (!isFixed) continue;
      const weight = WEIGHTS[mismatch.category] ?? 10;
      const mult = mismatch.severity === "critical" ? 1.5 : mismatch.severity === "warning" ? 1.0 : 0.5;
      penaltyRemoved += weight * mult;
    }

    return Math.min(100, Math.round(report.score + penaltyRemoved));
  }
}
