# Canvas migration boundary

The target is an installable App whose UI, document model, persistence,
assets, editing behavior, and MCP tool handlers all live in this marketplace
plugin. DUYA owns only the reusable App host: package discovery, isolated
rendering, lifecycle, capability approval, scoped MCP access, and updates.
The host must not contain Canvas tool names, canvas state, Canvas IPC routes,
or calls into DUYA's Conductor package for this plugin.

## Host integration status

The corresponding DUYA development branch adds a generic standalone App
runtime: launch without a chat run, a revocable App lifetime, explicit MCP
capability approval, and reload notification on plugin changes. The agent's
MCP service and the Mini App's service are separate processes. The plugin
store uses a cross-process lock so those processes do not overwrite each
other. Desktop installation and update behavior still need end-to-end review
before this host contract can be considered stable.

These are generic DUYA plugin platform changes. They must work for any App,
without references to Canvas in the host implementation.

## Plugin work remaining

- Port the original editor's behavior and reusable domain logic into this
  package, adapting dependencies on DUYA renderer state and IPC to the generic
  App bridge and plugin-owned MCP service.
- Expand plugin-owned storage and asset handling beyond the current JSON
  document store and local upload/download path. Existing DUYA asset files
  still need an explicit copy path.
- Preserve the original feature set, including rich native elements,
  connections, presentation, workbench/data views, undo/redo, and integration
  between the visual editor and agent tool calls.
- The plugin now provides an explicit read-only SQLite export script and a
  bundle import tool. Installation never silently reads or deletes DUYA data.
  Existing asset files and dynamic widget execution still need migration.
- After an installed desktop build supports opening, editing, reloading,
  permissions, and agent MCP calls end to end, switch the DUYA entry point to
  the installed App. Remove the old implementation only after data migration
  and feature parity are established.

The current package is a useful vertical slice of plugin-owned UI and MCP
state. It is not the completed migration described above.
