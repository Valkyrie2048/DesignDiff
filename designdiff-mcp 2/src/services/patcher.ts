import { readFile } from "fs/promises";
import type { SyncPatch, ParityReport, PatchFormat, PatchChange } from "../types.js";

export class PatchGenerator {
  async generatePatch(report: ParityReport, format: PatchFormat = "diff"): Promise<SyncPatch> {
    let sourceCode = "";
    try {
      sourceCode = await readFile(report.codePath, "utf-8");
    } catch {
      sourceCode = "";
    }

    const changes = this.buildChanges(report, sourceCode);

    // BUG FIX: estimate score gain based on actual penalty math, not 8-per-change
    const estimatedScoreAfter = this.estimateScoreAfterPatch(report, changes);
    const patch = this.renderPatch(changes, report.codePath, sourceCode, format);

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
        // States can't be auto-patched — generate a TODO marker only
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
        const targetVal = mismatch.designValue.startsWith("token(")
          ? `var(--${mismatch.designValue.slice(6, mismatch.designValue.indexOf(")"))})`
          : mismatch.designValue.includes(" = ")
            ? `var(--${mismatch.designValue.split(" = ")[0].replace("var(--","").replace(")","")})` 
            : mismatch.designValue;

        changes.push({
          type: "replace",
          property: mismatch.property,
          from: mismatch.codeValue,
          to: targetVal,
          // BUG FIX: search both camelCase and kebab-case for JSX/TSX files
          location: this.findPropertyLocation(source, mismatch.property),
        });
        continue;
      }

      // spacing, typography, border
      changes.push({
        type: "replace",
        property: mismatch.property,
        from: mismatch.codeValue,
        to: mismatch.designValue,
        location: this.findPropertyLocation(source, mismatch.property),
      });
    }

    return changes;
  }

  /**
   * BUG FIX: estimate score accurately by computing the penalty delta for fixed mismatches,
   * rather than adding a flat 8pts per change.
   */
  private estimateScoreAfterPatch(report: ParityReport, changes: PatchChange[]): number {
    const WEIGHTS: Record<string, number> = {
      spacing: 18, color: 20, typography: 15, border: 12, state: 17, token: 18,
    };

    // Calculate penalty removed by applied changes (exclude state TODOs)
    let penaltyRemoved = 0;
    for (const mismatch of report.mismatches) {
      if (mismatch.category === "state") continue; // TODOs don't fix anything
      const isFixed = changes.some(c => c.property === mismatch.property && c.type === "replace");
      if (!isFixed) continue;
      const weight = WEIGHTS[mismatch.category] ?? 10;
      const mult = mismatch.severity === "critical" ? 1.5 : mismatch.severity === "warning" ? 1.0 : 0.5;
      penaltyRemoved += weight * mult;
    }

    return Math.min(100, Math.round(report.score + penaltyRemoved));
  }

  private renderPatch(changes: PatchChange[], filePath: string, source: string, format: PatchFormat): string {
    switch (format) {
      case "diff": return this.renderDiff(changes, filePath);
      case "jsx": return this.renderJsx(changes, filePath);
      case "css": return this.renderCss(changes, filePath);
      case "json": return JSON.stringify({ file: filePath, changes }, null, 2);
    }
  }

  private renderDiff(changes: PatchChange[], filePath: string): string {
    const lines = [`--- a/${filePath}`, `+++ b/${filePath}`, ""];

    for (const change of changes) {
      if (change.type === "replace") {
        lines.push(`@@ ${change.location ?? "location unknown"} @@`);
        lines.push(`-  ${change.property}: ${change.from};`);
        lines.push(`+  ${change.property}: ${change.to};`);
        lines.push("");
      } else if (change.type === "add") {
        lines.push(`@@ end of file @@`);
        lines.push(`+  ${change.to}`);
        lines.push("");
      }
    }

    if (lines.length <= 3) {
      lines.push("// No patchable changes — all issues require manual intervention.");
    }

    return lines.join("\n");
  }

  private renderJsx(changes: PatchChange[], filePath: string): string {
    const replaces = changes.filter(c => c.type === "replace");
    const adds = changes.filter(c => c.type === "add");

    const styleLines = replaces.map(c => {
      // BUG FIX: output camelCase for JSX style objects
      const camel = c.property.replace(/-([a-z])/g, (_, l: string) => l.toUpperCase());
      return `  ${camel}: "${c.to}", // was: "${c.from}" (${c.location ?? "unknown location"})`;
    });

    return [
      `// DesignDiff patch — ${filePath}`,
      `// Apply corrections to the component's style prop or className:`,
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
      ...replaces.map(c => `  ${c.property}: ${c.to}; /* was: ${c.from} */`),
      `}`,
      ...(adds.length ? [
        ``,
        `/* Missing states: */`,
        ...adds.map(c => `/* ${c.to} */`),
      ] : []),
    ].join("\n");
  }

  /**
   * BUG FIX: search both kebab-case (CSS files) and camelCase (JSX/TSX)
   */
  private findPropertyLocation(source: string, property: string): string {
    if (!source) return "location unknown — file not found";

    const lines = source.split("\n");
    const kebab = property.replace(/([A-Z])/g, "-$1").toLowerCase();
    const camel = property.replace(/-([a-z])/g, (_, l: string) => l.toUpperCase());
    // Also strip " state" or " (token)" suffixes that come from mismatch property names
    const clean = kebab.replace(/ \(.*\)/, "").replace(/ state/, "").trim();

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.includes(clean) || line.includes(camel) || line.includes(kebab)) {
        return `line ${i + 1}`;
      }
    }

    return "location unknown";
  }
}
