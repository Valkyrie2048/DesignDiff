# DesignDiff MCP

**AI implementation verification engine for Figma and MCP-compatible coding agents.**

DesignDiff verifies that AI-generated interfaces match your Figma design system before they ship. It reads the Figma spec, renders your component in a real browser, compares computed CSS output, and returns patch-ready fixes — all inside your existing coding agent session.

```
Claude Code / Cursor / Windsurf
         ↓
   DesignDiff MCP
         ↓
  Figma REST API  +  Playwright renderer
         ↓
  Scored diff  +  Patch-ready fix
         ↓
    Agent applies  →  Re-checks: 94/100
```

## Why

AI agents generate UI code from Figma specs and get it mostly right — but not exactly. The typical failure pattern:

- **Token violations** — hardcoded `#2563EB` instead of `var(--brand-blue-600)`. Works today, breaks on the next brand refresh.
- **Spacing drift** — padding is 12px not 16px because the agent approximated instead of reading the exact value.
- **Missing states** — hover, focus, and disabled were defined in Figma variants the agent didn't parse.

The component looks correct visually. That's what makes this dangerous. DesignDiff catches these errors before they land in a PR.

## Quick start

**1. Get your Figma API key**
[Settings → Account → Personal access tokens](https://help.figma.com/hc/en-us/articles/8085703771159)

**2. Add to your agent config**

Claude Code (`~/.config/claude/mcp.json`):
```json
{
  "mcpServers": {
    "designdiff": {
      "command": "npx",
      "args": ["-y", "designdiff-mcp"],
      "env": { "FIGMA_API_KEY": "your-token-here" }
    }
  }
}
```

Same format for Cursor (`.cursor/mcp.json`), Windsurf, VS Code Copilot, and Zed.

**3. Say to your agent**

```
"Build the Button component from Figma file abc123, node 123:456,
running at localhost:6006 — and verify it matches the spec"
```

DesignDiff is called automatically when the agent generates or modifies a component.

> **Works best with** Storybook, local preview routes, or any stable component URL your agent can render.

## Tools

### `check_component_parity` — ships now

Diffs the Figma design spec against computed browser CSS. Returns a scored parity report with ranked mismatches and a patch-ready fix when score drops below threshold.

```typescript
check_component_parity({
  file_id: "abc123",           // Figma file ID from URL
  node_id: "123:456",          // Component node ID
  component_url: "http://localhost:6006/story/button--primary",
  code_path: "src/components/Button.tsx",
  threshold: 80,               // Score below which fix is generated (default: 80)
})
```

**What it checks:** spacing, color tokens, typography, borders, border-radius, interactive states.

**What it returns:** 0–100 parity score, ranked mismatches with consequences, pattern detection (e.g. "AI-generated code signature"), and a patch-ready git diff.

---

### `flag_stale_mappings` — ships now

Cross-references Code Connect mappings in your repo against Figma version history and git blame. Surfaces components that have drifted silently, ranked by blast radius and days since divergence.

```typescript
flag_stale_mappings({
  file_id: "abc123",
  repo_root: ".",              // Path to your repo root
})
```

Reads from `.figma/code-connect.json` in your repo root.

---

### `generate_sync_patch` — ships now

Generates a surgical patch for a specific component — token substitutions, prop corrections, missing state stubs. Output as git diff, JSX corrections, or CSS delta.

```typescript
generate_sync_patch({
  file_id: "abc123",
  node_id: "123:456",
  code_path: "src/components/Button.tsx",
  format: "diff",              // "diff" | "jsx" | "css"
})
```

---

### `audit_state_coverage` — v0.2

Checks whether every interactive state defined in a Figma component set (hover, focus, disabled, error, loading) exists in code. Flags WCAG 2.4.7 risk for missing focus rings.

### `check_responsive_parity` — v0.2

Renders at 375/768/1280/1920px and catches overflow, collapsed containers, and flex direction errors.

### `check_theme_parity` — v0.2

Runs parity across Figma variable modes — light/dark, brand variants, high-contrast. Catches hardcoded colors that are invisible in light mode but break in dark.

## Finding your Figma IDs

**File ID:** From the URL — `figma.com/file/{FILE_ID}/...`

**Node ID:** Right-click a component in Figma → Copy link → extract the `node-id` parameter. Format: `123:456`. Note: the URL uses `123-456` (hyphen) but the API uses `123:456` (colon) — DesignDiff handles the encoding automatically.

## How it works

1. **Fetch** — Calls the Figma REST API and extracts the full design spec: exact pixel values, token references, and every variant state from the component set.

2. **Render** — Launches a headless Playwright browser and renders your component at its real URL. Captures computed CSS — what the browser actually produces after cascade and runtime overrides resolve.

3. **Score** — Compares the two. Token violations score highest (they break the entire design system contract). Missing focus states are flagged with WCAG reference. Every mismatch includes the real-world consequence of not fixing it.

4. **Fix** — When score is below threshold, generates a patch-ready diff the agent applies in the same response, then re-verifies the score improved.

## Configuration

| Environment variable | Required | Default | Description |
|---|---|---|---|
| `FIGMA_API_KEY` | ✓ | — | Figma personal access token |
| `TRANSPORT` | — | `stdio` | `stdio` or `http` |
| `PORT` | — | `3847` | HTTP port (when `TRANSPORT=http`) |

### HTTP transport

For use with non-stdio MCP clients:

```bash
FIGMA_API_KEY=xxx TRANSPORT=http npx designdiff-mcp
# → DesignDiff MCP v0.2 running at http://localhost:3847/mcp
```

Health check: `GET /health`

## Development

```bash
git clone https://github.com/designdiff/designdiff-mcp
cd designdiff-mcp
npm install
npx playwright install chromium
npm run build
FIGMA_API_KEY=xxx npm start
```

**Inspect tools interactively:**
```bash
npm run inspector
```

This opens the MCP Inspector UI where you can call tools directly.

## Roadmap

| Stage | What ships |
|---|---|
| **v0.1 — Now** | Rendered parity check · token compliance · patch-ready diffs |
| **v0.2** | State coverage · responsive parity · theme parity · Storybook adapter |
| **v1.0** | Unified quality score · CI gate · score history · Slack alerts |

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT — see [LICENSE](./LICENSE).

---

By [Mathew Graham](https://github.com/mathewgraham)
