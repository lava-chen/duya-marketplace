# Canvas migration boundary

The target is an installable App whose UI, document model, persistence,
assets, editing behavior, and MCP tool handlers all live in this marketplace
plugin. DUYA owns only the reusable App host: package discovery, isolated
rendering, lifecycle, capability approval, scoped MCP access, and updates.
The host must not contain Canvas tool names, canvas state, Canvas IPC routes,
or calls into DUYA's Conductor package for this plugin.

## Current host gaps

1. Plugin App launch requires a chat session, and `bind` requires an active
   agent run. A user cannot keep an editor open and call its MCP service after
   that run finishes.
2. Invocation bindings expire after five minutes. App sessions need their own
   revocable lifetime, independent of agent attempts. Revocation, manifest
   drift, plugin disable, and package replacement must still fence calls.
3. MCP reload exists for the agent worker, but the App guest, tool catalog,
   and binding are not atomically replaced when a plugin updates. The generic
   host needs a versioned App session and update/reopen signal.
4. The capability grant ledger has an authenticated Host API, but there is no
   completed user approval flow for installed App capabilities.

These are generic DUYA plugin platform changes. They must work for any App,
without references to Canvas in the host implementation.

## Plugin work remaining

- Port the original editor's behavior and reusable domain logic into this
  package, adapting dependencies on DUYA renderer state and IPC to the generic
  App bridge and plugin-owned MCP service.
- Provide plugin-owned storage and asset handling with a documented schema
  migration path. The current JSON store covers only the prototype model.
- Preserve the original feature set, including rich native elements,
  connections, presentation, workbench/data views, undo/redo, and integration
  between the visual editor and agent tool calls.
- Offer an explicit export/import path from the built-in Canvas. Installation
  must never silently read or delete DUYA's existing user data.
- After an installed desktop build supports opening, editing, reloading,
  permissions, and agent MCP calls end to end, switch the DUYA entry point to
  the installed App. Remove the old implementation only after data migration
  and feature parity are established.

The current package is a useful vertical slice of plugin-owned UI and MCP
state. It is not the completed migration described above.
