export const FIGMA_API_BASE = "https://api.figma.com/v1";
export const DEFAULT_PARITY_THRESHOLD = 80;
export const MAX_RESPONSE_CHARS = 8000;
export const STALE_THRESHOLD_DAYS = 7;
export const CRITICAL_STALE_THRESHOLD_DAYS = 30;

// Properties we diff in order of importance
export const DIFFABLE_PROPERTIES = [
  "padding",
  "margin",
  "background",
  "color",
  "border-radius",
  "font-size",
  "font-weight",
  "font-family",
  "line-height",
  "letter-spacing",
  "border",
  "box-shadow",
  "opacity",
  "gap",
  "width",
  "height",
] as const;

export const SEVERITY_WEIGHTS: Record<string, number> = {
  color: 20,      // Raw hex instead of token = biggest design system failure
  spacing: 18,    // Padding/margin off = most visible
  state: 17,      // Missing states = UX failure
  typography: 15,
  border: 12,
  token: 18,      // Using hardcoded value instead of token
};

export const GRADE_THRESHOLDS = {
  A: 95,
  B: 85,
  C: 70,
  D: 55,
} as const;
