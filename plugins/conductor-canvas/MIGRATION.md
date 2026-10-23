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

## Runtime transition

The paired DUYA branch removes the former Conductor package, dedicated UI,
executor, modes, IPC, and database runtime. It retains historical database
files and migrations; the plugin importer owns the explicit copy operation.
DUYA hosts this editor through the same install, grant, sandbox, MCP, hot
reload, and shutdown interfaces used by other plugin Apps.

Real desktop acceptance and platform-specific limitations are recorded in the
paired migration PRs. Import representative existing canvases and retain the
source database while reviewing the copied data. Standalone Apps preserve
legacy chat-session references as links to copy; they cannot browse or switch
DUYA's private chat sessions.

The plugin's project database preserves typed sources, properties, records,
views, and query behavior behind a plugin-owned JSON store. Its request
contract is intentionally independent from DUYA's SQLite and IPC services.
Canvas settings also persist in plugin-owned storage. An optional
OpenAI-compatible provider handles widget refinement through a plugin-owned
prompt and validated JSON response; provider credentials stay in the private
plugin settings file and are omitted from status and model-list results.
