# Canvas migration boundary

The marketplace package owns Canvas UI, model, persistence, assets, editing
actions, project data, and MCP handlers. DUYA provides a generic plugin App
host: discovery, isolated rendering, lifecycle, capability approval, scoped
MCP access, and updates. The Canvas package has no runtime import or IPC
dependency on DUYA's former Conductor implementation.

## Data migration

Migration is explicit and copy-based. `legacy-export.cjs` opens the former
SQLite database read only, includes WAL content, and emits canvases, groups,
elements, widgets, action history, and optionally referenced asset files. For
each referenced project path it also reads `.duya/database.sqlite` and exports
the source, property, option, record, value, view, and related rows. The plugin
imports those rows into its own per-project store while retaining IDs and the
canvas-to-project link. It retains original v2 fields and connector endpoints
while remapping imported asset references into its own storage. Dynamic widget
code is retained as data and is never executed by the importer. Installation
does not silently read, change, or delete the former database or its asset
files.

## Remaining parity work

- Finish matching the former editor's rich interaction details and review the
  standalone editor against representative migrated canvases.
- Complete installed desktop end-to-end review for opening, editing, reload,
  capability permissions, and agent MCP access.
- Switch the DUYA entry point to the installed plugin only after migrated data
  and feature parity have been reviewed; remove the former implementation
  after that transition is complete.

The plugin's project database preserves typed sources, properties, records,
views, and query behavior behind a plugin-owned JSON store. Its request
contract is intentionally independent from DUYA's SQLite and IPC services.
Canvas settings also persist in plugin-owned storage. An optional
OpenAI-compatible provider handles widget refinement through a plugin-owned
prompt and validated JSON response; provider credentials stay in the private
plugin settings file and are omitted from status and model-list results.
