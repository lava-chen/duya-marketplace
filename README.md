# DUYA Marketplace

Official plugin marketplace for DUYA (`duya-official`), consumed by the
Plan 455 marketplace mechanism
(`docs/references/codex-deep-dive/17-plugin-marketplace-and-app-connector.md`).

## Layout

```
marketplace.json      ← catalog (plan-455 schema, see below)
plugins/
  <plugin>/           ← one directory per plugin (flat, including skills)
    .duya-plugin/plugin.json
    .app.json         ← optional app-connection declarations (see below)
    skills/           ← optional
    mcp/              ← optional (mcp/servers.json)
    workflows/        ← optional
    permissions/      ← optional (permissions/policy.json)
scripts/
  generate-catalog.py ← regenerates plugins/ + marketplace.json from duya sources
```

## App connections (`.app.json`)

App-connection declarations follow plan 455-open-connector-registry D3:
one `<pluginDir>/.app.json` per plugin (codex `PluginAppFile` parity).
Reference-style subset used by this repo:

```json
{
  "apps": {
    "figma": { "id": "figma" },
    "slack": { "id": "slack" }
  }
}
```

`id` is the connector id from the AppConnectorRegistry (the 11 builtin
provider ids for first-party packs). The definition-style subset
(`oauth` + `tools[]`) is reserved for plan 460 and not used here yet.

Catalog `policy.authentication: on_install` is set for plugins whose app
connection is core to their function (the connector plugins and the
provider packs); `design-suite` keeps `on_use` because its apps are
optional integrations.

## Deduplication policy

- builtin `github` / `notion` are **not** mirrored: the richer plan-313
  packs `github-development` / `notion-knowledge` supersede them and carry
  their app connections via `.app.json`.
- `wecom` stays as the builtin plugin (credentials-based setup, no OAuth
  connector plugin).

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
- Everything else (version, description, author, capabilities, permissions)
  is read from each plugin's own `.duya-plugin/plugin.json` and on-disk
  capability directories — disk is the single source of truth.

## Adding / regenerating

`scripts/generate-catalog.py` rebuilds the full catalog from the duya sources:

- 7 builtin plugins from `packages/plugin-core/src/plugins/builtin/`
  (documents, obsidian, pdf, presentations, spreadsheets, wecom, zotero)
- every bundled skill from `packages/agent/skills/` packaged as a
  single-skill plugin, flat under `plugins/<skill-name>/`
- connector plugins for app providers without a dedicated plugin
  (google, slack, microsoft365)

```
python scripts/generate-catalog.py
```

The script is idempotent (it wipes and re-copies the generated plugin
directories); hand-edited plugins not touched by the script are preserved
and re-registered in `marketplace.json` on the next run.

## Adding a Plugin

1. Create `plugins/<name>/.duya-plugin/plugin.json` (plus optional
   `.app.json` and capability directories) — or use
   `scripts/generate-catalog.py` for bundled content.
2. Run `python scripts/generate-catalog.py` to re-register it in the catalog.
3. Commit and push.
