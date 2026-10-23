# Standalone Mini App plugin template

Copy this directory from the installed `app-builder` plugin to your own
plugin project. Change the plugin ID, name, App ID, capability ID, tool names,
and UI. Keep the matching declarations in `.duya-plugin/plugin.json`,
`mcp/servers.json`, and `permissions/policy.json`.
The `apps/notes/index.html` page communicates only through the generic
`duya.plugin-app` `bind` / `invoke` message protocol; it has no DUYA preload or
Canvas-specific IPC dependency.
Each request includes `documentToken` from the first path segment of the
session-scoped App URL, and responses are accepted only from `window.parent`.

Keep the plugin ID stable across updates. It identifies the installed plugin
and its persistent data directory. Keep the App ID stable too; increment
`version` for a package update and increment `stateSchemaVersion` when the
DUYA-managed App instance schema changes.

Install the copied directory from a terminal connected to DUYA:

```sh
duya plugin install --from-path ./notes-mini-app --yes
```

`--yes` is required for non-interactive CLI use. The installed plugin's App
launcher appears on its row in Settings → Capabilities → Plugins. Open Notes
and grant the listed `notes.data` MCP tool scope when DUYA asks. An agent run
can call the same plugin MCP tools after the normal tool approval.

The App and the agent use separate MCP processes. The example's `server.cjs`
shares notes through `${DUYA_PLUGIN_DATA}/notes.json` and a cross-process file
lock. Keep this property if your App and agent both edit the same data. DUYA
owns the directory and supplies its path to the MCP process through
`mcp/servers.json` environment expansion.

On every App launch DUYA resolves the installed manifest, asks for the App's
declared tool capability, starts the scoped MCP service, and binds only the
allowed tools. Reinstalling this plugin ID replaces its package while keeping
the data directory; DUYA invalidates open App sessions so the UI reloads. A
revoked grant or changed tool scope makes calls fail until DUYA grants the
current scope again.

The scaffold MCP server can be smoke-tested with Node.js without installing
DUYA:

```sh
node --test test/template.test.cjs
```

Standalone App hosting requires a DUYA build with `runtime: "standalone"`
support. The generic host loads this UI from the installed plugin package and
brokers its scoped MCP calls; the plugin does not need a DUYA preload or
product-specific IPC.
