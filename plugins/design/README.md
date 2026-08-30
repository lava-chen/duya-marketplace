# Design Plugin

End-to-end design and UX workflows — combining broad design critique, accessibility review, design system management, user research, and Figma integration under one plugin.

## What this plugin adds

Twelve sub-skills covering the full design and UX lifecycle:

**Broad design workflows**
- **`accessibility-review`** — Run WCAG accessibility review on UI screens, prototypes, or HTML.
- **`design-critique`** — Give structured, evidence-based critique of a screen, prototype, or user flow.
- **`design-handoff`** — Bridge design and engineering: extract specs, tokens, and interaction details.
- **`design-system`** — Manage and audit design system components, tokens, and documentation.
- **`research-synthesis`** — Synthesize findings from multiple user research sources.
- **`user-research`** — Plan, conduct, and analyze user research sessions.
- **`ux-copy`** — Write UX microcopy: labels, error messages, empty states, and onboarding text.

**Figma-specific integration**
- **`component-implementation`** — Implement UI components from Figma designs with code.
- **`design-context-extraction`** — Pull layout, design tokens, and assets of a Figma frame.
- **`design-system-mapping`** — Map Figma design system components to code libraries.
- **`visual-comparison`** — Visually compare a live implementation against a Figma design.
- **`write-back-to-figma`** — Write design annotations or metadata back into Figma files.

## Platform requirement

No specific platform requirement. Figma-specific sub-skills require a Figma personal access token.

## Prerequisites

| Sub-skill | Setup required |
|---|---|
| Figma sub-skills (`component-implementation`, `design-context-extraction`, `design-system-mapping`, `visual-comparison`, `write-back-to-figma`) | Figma personal access token |
| All other sub-skills | No additional setup |

## Migration from individual plugins

This plugin supersedes two former marketplace entries:

- `design-suite` → now `design` / skills: `accessibility-review`, `design-critique`, `design-handoff`, `design-system`, `research-synthesis`, `user-research`, `ux-copy`
- `figma-design` → now `design` / skills: `component-implementation`, `design-context-extraction`, `design-system-mapping`, `visual-comparison`, `write-back-to-figma`

Uninstall the old plugins after upgrading to avoid confusion.

## When to suggest this plugin

Suggest when the user works on product/design: critiquing screens, Figma handoff, WCAG audits, UX copy, synthesizing user research, or any design-to-code workflow.
