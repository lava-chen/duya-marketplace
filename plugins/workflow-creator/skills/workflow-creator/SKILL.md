---
name: workflow-creator
description: "Turn a repeated workflow into a DUYA plugin or Skill. Use when the user wants to capture a recurring pattern as a reusable asset, create a new plugin (full capability surface — hooks/MCP/CLI/UI), create a new Skill (prompt-level knowledge only), or update an existing local plugin/skill during development. Covers both forms in one workflow."
allowed-tools: "Bash, Read, Write, Edit, Glob, Grep"
---

# Workflow Creator

Turn a repeated workflow into a DUYA plugin or Skill. One skill covers
both forms so the user decides packaging from one place.

## 0. Decide the form first

Before any file gets written, classify what the workflow needs. The
boundary is not arbitrary — it follows the underlying capability
surface:

| Workflow needs... | Form | Why |
|---|---|---|
| Prompt-level knowledge, decisions, or a procedure another DUYA instance should follow | **Skill** | Skills are loaded into context; they teach. |
| New MCP servers, hook handlers, CLI commands, or sidebar UI contributions | **Plugin** | These run code; skills cannot. |
| Both prompt-level guidance **and** runtime capabilities | **Plugin with skills** | The plugin is the unit of distribution; skills hang off it. |

Default to **Skill** when the only thing to capture is "here is how to
think about X / do X correctly" — Skills are cheaper, easier to iterate,
and require no manifest. Promote to **Plugin** the moment the workflow
needs to *do* something beyond text generation (call an API, register a
hook, expose a UI).

**Don't ship a Plugin when a Skill suffices.** A plugin without
capabilities (skills/hooks/MCP/CLI/UI) is just a Skill wearing heavier
clothes — and heavier clothes mean a manifest, a `schemaVersion`, an
`engines` field, marketplace entry wiring. None of that earns its keep
when the deliverable is purely knowledge.

## 1. Skill path — capture prompt-level knowledge

Use the existing `skill-creator` skill at `packages/agent/skills/.system/skill-creator/`
for the full Skill design discipline (concise-by-default,
progressive disclosure, three-level loading, validation, naming,
forward-testing). The compact checklist:

### SKILL.md anatomy

```
skill-name/
├── SKILL.md           # required: YAML frontmatter + Markdown body
├── scripts/           # optional: executable code (Python/Bash/etc.)
├── references/        # optional: docs loaded as needed
└── assets/            # optional: files used in output (templates, icons)
```

### SKILL.md frontmatter

- `name` (required) — lowercase kebab-case, must match folder name
- `description` (required) — **the primary trigger**; describe what the
  skill does AND when to use it. Put all "when to use" guidance here;
  the body only loads after triggering.
- `allowed-tools` (optional) — comma-separated tool allowlist
- `user-invocable` (optional) — `false` hides it from the user list
- `platforms` (optional) — platform restrictions

### Design rules

- **Concise is key.** Skills share context with the system prompt,
  conversation, and other skills' metadata. Only add context DUYA does
  not already have.
- **Three-level loading**: metadata always loaded → body loaded on
  trigger → bundled resources loaded only as needed.
- Keep the body under 500 lines. Move variant-specific details into
  reference files linked from SKILL.md (one level deep).
- Do **not** add `README.md`, `INSTALLATION_GUIDE.md`,
  `CHANGELOG.md` — they add clutter without helping the agent.

### Location choices

- **Built-in** (ships with DUYA): `packages/agent/skills/<category>/<skill>/`
- **User**: `~/.duya/skills/<skill>/`
- **Project** (cross-agent standard): `.agent/skills/<skill>/` or `.duya/skills/<skill>/`

### Validation

- Re-read the skill with fresh eyes: does the description trigger
  correctly? Body under control? References resolve?
- For complex skills, forward-test with a subagent on a realistic task.
- If forward-testing only succeeds when the subagent sees leaked
  context, the skill is broken — tighten before trusting.

## 2. Plugin path — capture capabilities

Use `scripts/create-basic-plugin.mjs` from the DUYA project root.
Scripts live at `<duya-root>/scripts/`. By default, plugins are created
in DUYA's `userData/plugins` directory. Use `--dev` when running
`npm run electron:dev` (target: `userData/duya-dev/plugins/`).

### Scaffold

```bash
node scripts/create-basic-plugin.mjs <plugin-name>
```

Plugin names normalize to lowercase kebab-case (max 64 chars). Run
from the DUYA project root (where `package.json` lives).

Flags for capabilities:

| Flag | Creates | plugin.json field |
|------|---------|------------------|
| `--with-skills` | `skills/` | `"skills": [...]` |
| `--with-hooks` | `hooks/hooks.json` | `"hooks": [...]` |
| `--with-mcp` | `.mcp.json` | `"mcpServers": [...]` |
| `--with-cli` | `commands/` or `scripts/` | `"cli": [...]` |
| `--with-ui` | `ui/` | `"ui": [...]` |

Combine flags as needed:

```bash
node scripts/create-basic-plugin.mjs my-plugin \
  --with-skills --with-hooks --with-mcp
```

### Manifest format (`duya.plugin.v1`)

The manifest at the plugin root must follow the `duya.plugin.v1`
schema. Fields marked **(required)** are enforced by the manifest
parser at `electron/plugins/manifest.ts`.

```json
{
  "schemaVersion": "duya.plugin.v1",
  "id": "com.duya.my-plugin",
  "name": "my-plugin",
  "version": "0.1.0",
  "description": "What this plugin does in one sentence",
  "author": {
    "name": "Your Name",
    "url": "https://github.com/yourname"
  },
  "capabilities": {
    "skills": ["./skills/my-skill/SKILL.md"],
    "mcpServers": [
      { "name": "filesystem", "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"] }
    ],
    "cli": [{ "name": "deploy", "command": "./scripts/deploy.sh" }],
    "hooks": [{ "event": "PreToolUse", "handler": "./hooks/hooks.json" }],
    "ui": [{ "id": "my-panel", "type": "sidebar", "entry": "./ui/panel.html" }]
  },
  "permissions": [{ "name": "file-read", "scope": "project" }],
  "setup": [{ "id": "api-key", "label": "API Key", "type": "secret", "required": true }],
  "engines": { "duya": ">=0.9.0", "node": ">=18" }
}
```

Field requirements:**Top-level required** — `schemaVersion`, `id`,
`name`, `version`, `description`, `author`, `capabilities`,
`permissions`, `engines`. **Optional** — `setup`. **Per capability** —
omit keys for capabilities the plugin does not provide (do not emit
empty arrays).

### Directory layout (full manifest)

```
my-plugin/
├── plugin.json             # required
├── skills/                 # optional: skill definitions
│   └── my-skill/SKILL.md
├── commands/               # optional: slash command definitions
├── agents/                 # optional: sub-agent definitions
├── hooks/                  # optional: hooks/hooks.json
└── .mcp.json               # optional: MCP server configs
```

### Standard Agent Plugins format (`--standard`)

Generated with `--standard`. The manifest targets
[Agent Plugins 1.0.0](https://agent-plugins.org/) so the package's
portable parts (skills, MCP) work in any compatible client. DUYA-only
fields are namespaced under `extensions["com.duya.client"]`.

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "my-plugin",
  "version": "0.1.0",
  "description": "Plugin: my-plugin",
  "author": { "name": "Your Name" },
  "license": "MIT",
  "extensions": {
    "com.duya.client": {
      "engines": { "duya": ">=0.9.0" },
      "permissions": [],
      "cli": [],
      "ui": []
    }
  }
}
```

Standard layout:

```
my-plugin/
├── plugin.json             # standard $schema manifest
├── skills/                 # portable
├── mcp.json                # portable: standard mcpServers map
└── hooks/                  # DUYA-only
```

### Validation and cachebuster flow

Before handing back:

```bash
node scripts/validate-plugin.mjs <plugin-path>
```

Validator checks against `electron/plugins/manifest.ts` expectations:
`schemaVersion`, `id`, `capabilities` is object, `permissions` is
array, `engines.duya` present, no `[TODO: ...]` placeholders, all
referenced file paths resolve, skill `SKILL.md` frontmatter parses,
MCP server configs have `name` and `command`.

For updates to an existing local plugin, append a cachebuster suffix
to trigger a fresh load:

```bash
node scripts/update-plugin-cachebuster.mjs <plugin-path>
```

Format: `<base-version>+duya.local-<YYYYMMDD-HHMMSS>`. Preserve the
semver prefix; replace only the suffix.

Then reinstall (DUYA catalog UI → remove + install, or
`plugin.installLocal` IPC) and restart DUYA.

### Marketplace entry

Generate a marketplace entry so the plugin appears in the catalog:

```bash
node scripts/create-basic-plugin.mjs my-plugin --with-marketplace
```

Marketplace entry shape:

```json
{
  "name": "personal",
  "plugins": [{
    "name": "my-plugin",
    "source": { "source": "local", "path": "./plugins/my-plugin" },
    "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
    "category": "Productivity"
  }]
}
```

Category values: `productivity`, `development`, `research`, `data`,
`communication`, `media`, `automation`, `other`. Policy
`installation`: `NOT_AVAILABLE | AVAILABLE | INSTALLED_BY_DEFAULT`.
`authentication`: `ON_INSTALL | ON_USE`.

DUYA reads this file on startup via `electron/plugins/catalog.ts`. A
restart is required to see new entries in the catalog.

## 3. Decision checklist

Before writing any file:

1. **What does the workflow need?** If only prompt knowledge → Skill.
   If it needs hooks / MCP / CLI / UI → Plugin. If both → Plugin with
   skills.
2. **Is it recurring enough to package?** One-off tasks do not need a
   Skill. Repeat the same shape three or more times before paying the
   packaging cost.
3. **Does the description trigger correctly?** For Skills, the
   `description` field is the only thing DUYA sees before triggering.
   For Plugins, the `description` field is what shows in the catalog.
   If you cannot write a tight trigger description, the workflow is
   probably not yet clear enough to package.
4. **Where does it live?** Built-in (DUYA upgrade with it), user
   (`~/.duya/skills/`), or project (`.agent/skills/` /
   `.duya/skills/`)? Pick the narrowest scope that still serves the
   need.

## 4. Common mistakes

- Do **not** package a workflow that has not actually repeated. A
  Skill written from a single anecdote tends to overfit and trigger
  wrongly.
- Do **not** emit a Plugin without capabilities just because the user
  asked for "a plugin". A capability-less plugin is a Skill wearing
  unnecessary scaffolding.
- Do **not** leave `[TODO: ...]` placeholders in either Skills or
  Plugins — validation rejects them.
- Do **not** skip the validation script before handing back. Manifest
  schema errors surface there, not at runtime.
- Do **not** hand-edit `config.toml` for capabilities that have a
  dedicated tool — use `duya_cli` instead.

## Related

- For the Skill design discipline in full, read
  `packages/agent/skills/.system/skill-creator/SKILL.md`.
- For the manifest parser implementation, see
  `electron/plugins/manifest.ts`.
- For the personal marketplace file location and shape, see the
  `Marketplace Workflow` section of the original `plugin-development`
  skill (kept verbatim in the duya source tree).