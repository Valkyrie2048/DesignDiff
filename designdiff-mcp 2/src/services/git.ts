import { simpleGit, type SimpleGit } from "simple-git";
import { readFile, stat } from "fs/promises";
import { join } from "path";
import { STALE_THRESHOLD_DAYS, CRITICAL_STALE_THRESHOLD_DAYS } from "../constants.js";
import type { CodeConnectMapping, StaleMappingsReport } from "../types.js";

interface CodeConnectEntry {
  figmaNode: string;
  component: string;
  filepath: string;
}

export class GitService {
  /**
   * Read Code Connect mappings from the local .figma/code-connect.json file.
   * BUG FIX: Code Connect paths live in the repo, NOT in the Figma API response.
   */
  async readCodeConnectFile(repoRoot: string): Promise<CodeConnectEntry[]> {
    const candidates = [
      join(repoRoot, ".figma", "code-connect.json"),
      join(repoRoot, "code-connect.json"),
      join(repoRoot, "figma", "code-connect.json"),
    ];

    for (const candidate of candidates) {
      try {
        const content = await readFile(candidate, "utf-8");
        const parsed = JSON.parse(content) as { connections?: CodeConnectEntry[]; mappings?: CodeConnectEntry[] };
        return parsed.connections ?? parsed.mappings ?? [];
      } catch { /* try next */ }
    }

    return []; // No Code Connect file found — caller handles gracefully
  }

  async buildStaleMappingsReport(
    fileId: string,
    figmaMappings: Array<{ nodeId: string; componentName: string; lastModified: string }>,
    repoRoot: string
  ): Promise<StaleMappingsReport> {
    const git = simpleGit(repoRoot);
    const codeConnectEntries = await this.readCodeConnectFile(repoRoot);

    // Build lookup: figmaNode -> filepath
    const codeConnectByNode = new Map(
      codeConnectEntries.map(e => [e.figmaNode, e.filepath])
    );

    const results: CodeConnectMapping[] = [];

    for (const mapping of figmaMappings) {
      const codePath = codeConnectByNode.get(mapping.nodeId);
      if (!codePath) continue; // Not mapped — skip

      const fullPath = join(repoRoot, codePath);
      const codeLastModified = await this.getFileLastModified(fullPath, git);

      const designDate = new Date(mapping.lastModified);
      const codeDate = new Date(codeLastModified);
      const daysSinceSync = Math.floor(
        (designDate.getTime() - codeDate.getTime()) / (1000 * 60 * 60 * 24)
      );

      const staleness =
        daysSinceSync > CRITICAL_STALE_THRESHOLD_DAYS ? "critical"
        : daysSinceSync > STALE_THRESHOLD_DAYS ? "stale"
        : "fresh";

      results.push({
        figmaNodeId: mapping.nodeId,
        figmaComponentName: mapping.componentName,
        figmaLastModified: mapping.lastModified,
        codePath,
        codeLastModified,
        mappingLastSynced: codeLastModified,
        staleness,
        daysSinceSync: Math.max(0, daysSinceSync),
        impact: this.assessImpact(mapping.componentName, staleness),
      });
    }

    results.sort((a, b) => {
      const order: Record<string, number> = { critical: 0, stale: 1, fresh: 2 };
      const diff = (order[a.staleness] ?? 3) - (order[b.staleness] ?? 3);
      return diff !== 0 ? diff : b.daysSinceSync - a.daysSinceSync;
    });

    return {
      fileId,
      totalMappings: results.length,
      staleMappings: results.filter(r => r.staleness !== "fresh").length,
      criticalMappings: results.filter(r => r.staleness === "critical").length,
      mappings: results,
      checkedAt: new Date().toISOString(),
    };
  }

  private async getFileLastModified(filePath: string, git: SimpleGit): Promise<string> {
    try {
      const log = await git.log({ file: filePath, maxCount: 1 });
      if (log.latest?.date) return log.latest.date;
    } catch { /* fall through */ }

    try {
      const s = await stat(filePath);
      return s.mtime.toISOString();
    } catch {
      return new Date(0).toISOString();
    }
  }

  private assessImpact(componentName: string, staleness: string): "high" | "medium" | "low" {
    if (staleness === "critical") return "high";
    const highImpact = ["Button", "Input", "Modal", "Nav", "Header", "Card", "Form", "Table", "Select"];
    return highImpact.some(p => componentName.toLowerCase().includes(p.toLowerCase()))
      ? "high"
      : staleness === "stale" ? "medium" : "low";
  }
}
