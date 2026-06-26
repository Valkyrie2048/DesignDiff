// ─── Core domain types ────────────────────────────────────────────────────────

export interface FigmaNodeSpec {
  nodeId: string;
  name: string;
  componentKey?: string;
  tokens: DesignTokenMap;
  spacing: SpacingSpec;
  typography?: TypographySpec;
  borders?: BorderSpec;
  states: StateSpec[];
  children?: FigmaNodeSpec[];
}

export interface DesignTokenMap {
  [property: string]: TokenValue;
}

export interface TokenValue {
  raw: string;           // e.g. "#2563EB"
  token?: string;        // e.g. "brand-blue-600"
  resolvedValue: string; // computed final value
}

export interface SpacingSpec {
  padding?: { top: number; right: number; bottom: number; left: number };
  margin?: { top: number; right: number; bottom: number; left: number };
  gap?: number;
  width?: number | string;
  height?: number | string;
  borderRadius?: number | number[];
}

export interface TypographySpec {
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  lineHeight: number | string;
  letterSpacing?: number;
  textTransform?: string;
  color: TokenValue;
}

export interface BorderSpec {
  width: number;
  style: string;
  color: TokenValue;
  radius?: number | number[];
}

export interface StateSpec {
  name: string; // "hover", "focus", "active", "disabled", "error"
  overrides: Partial<DesignTokenMap & SpacingSpec>;
}

// ─── Parity types ─────────────────────────────────────────────────────────────

export interface ParityMismatch {
  property: string;
  designValue: string;
  codeValue: string;
  severity: "critical" | "warning" | "info";
  category: "spacing" | "color" | "typography" | "border" | "state" | "token";
  fix?: string; // Human-readable fix suggestion
}

export interface ParityReport {
  nodeId: string;
  codePath: string;
  score: number; // 0–100
  grade: "A" | "B" | "C" | "D" | "F";
  patchAvailable: boolean;
  mismatches: ParityMismatch[];
  categories: {
    spacing: CategoryScore;
    color: CategoryScore;
    typography: CategoryScore;
    border: CategoryScore;
    states: CategoryScore;
    tokens: CategoryScore;
  };
  checkedAt: string;
}

export interface CategoryScore {
  score: number;
  passed: number;
  failed: number;
  mismatches: ParityMismatch[];
}

// ─── Stale mapping types ──────────────────────────────────────────────────────

export interface CodeConnectMapping {
  figmaNodeId: string;
  figmaComponentName: string;
  figmaLastModified: string;
  codePath: string;
  codeLastModified: string;
  mappingLastSynced: string;
  staleness: "fresh" | "stale" | "critical";
  daysSinceSync: number;
  impact: "high" | "medium" | "low";
}

export interface StaleMappingsReport {
  fileId: string;
  totalMappings: number;
  staleMappings: number;
  criticalMappings: number;
  mappings: CodeConnectMapping[];
  checkedAt: string;
}

// ─── Patch types ──────────────────────────────────────────────────────────────

export type PatchFormat = "diff" | "jsx" | "css" | "json";

export interface SyncPatch {
  nodeId: string;
  codePath: string;
  format: PatchFormat;
  parityScoreBefore: number;
  estimatedScoreAfter: number;
  changes: PatchChange[];
  patch: string; // The actual patch content
  appliedAt?: string;
}

export interface PatchChange {
  type: "replace" | "add" | "remove";
  property: string;
  from: string;
  to: string;
  location?: string; // e.g. "line 42" or "Button.tsx:padding"
}

// ─── Rendered CSS types ───────────────────────────────────────────────────────

export interface RenderedStyles {
  selector: string;
  computed: Record<string, string>;
  states: Record<string, Record<string, string>>; // e.g. { hover: { background: "..." } }
}

// ─── Config ───────────────────────────────────────────────────────────────────

export interface DesignDiffConfig {
  figmaApiKey: string;
  paritythreshold: number;    // default 80 — below triggers patch suggestion
  rendererType: "playwright" | "storybook";
  storybookUrl?: string;
  transport: "stdio" | "http";
  port?: number;
}

// ─── Source compliance types ──────────────────────────────────────────────────

export type ConfidenceLevel = "verified" | "likely" | "unable-to-verify";

export interface SourceComplianceReport {
  filePath: string;
  canScan: boolean;
  sourceCompliance: number;       // 0–100, -1 if unscannnable
  hardcodedColors: number;        // count of hardcoded color values found
  hardcodedSpacing: number;       // count of hardcoded spacing values
  tokenUsageCount: number;        // number of CSS custom properties in use
  violations: Array<{
    type: string;
    value: string;
    suggestedToken?: string;
    line: number;
    context: string;
    confidence: ConfidenceLevel;
  }>;
  note: string;                   // Human-readable summary of findings
}

// Extends ParityMismatch with confidence
export interface AnnotatedMismatch extends ParityMismatch {
  confidence: ConfidenceLevel;
  verificationMethod: "computed-style" | "source-scan" | "state-check";
}
