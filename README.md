# DUYA Marketplace

Official plugin marketplace for DUYA (`duya-official`), consumed by the
Plan 455 marketplace mechanism
(`docs/references/codex-deep-dive/17-plugin-marketplace-and-app-connector.md`).

## Layout

```
marketplace.json      ← catalog (plan-455 schema, see below)
plugins/
  <plugin>/           ← one directory per plugin
    .duya-plugin/plugin.json
    skills/           ← optional
    mcp/              ← optional (mcp/servers.json)
    apps/             ← optional (apps/connections.json — App Connection declarations)
    workflows/        ← optional
    permissions/      ← optional (permissions/policy.json)
  skills/<skill>/     ← bundled skills packaged as single-skill plugins
scripts/
  generate-catalog.py ← regenerates plugins/ + marketplace.json from duya sources
```

## Catalog format

`marketplace.json` follows the plan-455 reader schema
(`electron/plugins/marketplace/manifest.ts`):

```json
{
  "name": "duya-official",
  "interface": { "displayName": "DUYA Official" },
  "plugins": [
    {
      "name": "design-suite",
      "source": { "source": "local", "path": "./plugins/design-suite" },
      "policy": { "installation": "available", "authentication": "on_use" },
      "category": "development"
    }
  ]
}
```

- `source.path` is relative to this repo root and stays inside it (the duya
  reader enforces a path-containment fence — `../` and absolute paths are
  rejected).
- `policy.installation`: `available` / `not_available` / `installed_by_default`.
- `policy.authentication`: `on_install` (OAuth connection prompted at install;
  set for plugins declaring a `required: true` app) / `on_use` (lazy).
- Everything else (version, description, author, capabilities, permissions)
  is read from each plugin's own `.duya-plugin/plugin.json` and on-disk
  capability directories — disk is the single source of truth.

## Adding / regenerating

`scripts/generate-catalog.py` rebuilds the full catalog from the duya sources:

- 9 builtin plugins from `packages/plugin-core/src/plugins/builtin/`
  (documents, github, notion, obsidian, pdf, presentations, spreadsheets,
  wecom, zotero)
- every bundled skill from `packages/agent/skills/` packaged as a
  single-skill plugin under `plugins/skills/`
- connector plugins for app providers without a dedicated plugin
  (google, slack, microsoft365)

```
python scripts/generate-catalog.py
```

The script is idempotent (it wipes and re-copies the generated plugin
directories); hand-edited plugins not touched by the script are preserved
and re-registered in `marketplace.json` on the next run.

## Adding a Plugin

1. Create `plugins/<name>/.duya-plugin/plugin.json` (plus optional capability
   directories) — or use `scripts/generate-catalog.py` for bundled content.
2. Run `python scripts/generate-catalog.py` to re-register it in the catalog.
3. Commit and push.
