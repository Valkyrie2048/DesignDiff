# Contributing to DesignDiff

Thanks for your interest. DesignDiff is early — contributions that fix bugs or improve reliability are the most valuable right now.

## Setup

```bash
git clone https://github.com/designdiff/designdiff-mcp
cd designdiff-mcp
npm install
npx playwright install chromium
npm run build
```

## Project structure

```
src/
  index.ts              Server entry, transport config, env validation
  types.ts              Full domain type system
  constants.ts          Severity weights, grade thresholds, defaults
  services/
    figma.ts            Figma REST API — node spec extraction, COMPONENT_SET state detection
    renderer.ts         Playwright headless renderer, computed CSS, viewport-aware rendering
    differ.ts           Diff engine — deduplication, rgba() handling, scoring
    patcher.ts          Surgical patch generator — diff/jsx/css output, camelCase JSX support
    git.ts              Code Connect staleness detection via .figma/code-connect.json
    intelligence.ts     Consequence mapping, pattern detection, narrative generation
  tools/
    check_component_parity.ts
    flag_stale_mappings.ts
    generate_sync_patch.ts
    audit_state_coverage.ts
    check_responsive_parity.ts
    check_theme_parity.ts
```

## What to work on

Good first issues:
- Improving token resolution accuracy (resolving CSS custom property chains)
- Adding Vue/Svelte support to the patch generator
- Writing integration tests against a real Storybook instance
- Improving the COMPONENT_SET state extraction edge cases

Please open an issue before starting significant work so we can discuss approach first.

## Pull requests

- Keep PRs focused — one fix or feature per PR
- Include a description of what the PR changes and why
- If fixing a bug, include a reproduction case in the description
- TypeScript, no `any`, pass `tsc` cleanly

## Bugs

Open a GitHub issue with:
1. The tool call you made (parameters, not your API key)
2. The error or unexpected output
3. Your agent + OS
