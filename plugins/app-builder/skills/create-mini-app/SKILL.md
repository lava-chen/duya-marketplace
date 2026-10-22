---
name: create-mini-app
description: Create an installable standalone DUYA desktop Mini App plugin with plugin-owned UI, MCP tools, and data. Use when a user asks the agent to build a new desktop App plugin.
---

# Create a DUYA Mini App plugin

The installed `app-builder` package includes a working scaffold at
`templates/standalone-mini-app`. Copy that directory into the user's chosen
project, then adapt it. Never modify DUYA core to implement an individual App.

1. Pick a stable, unique reverse-domain plugin ID and a unique App ID. Change
   the manifest in the copied `.duya-plugin/plugin.json`. Keep the plugin ID
   stable across versions: DUYA uses it to locate the plugin's persistent data
   directory. Keep each `appId` stable too. Increment `version` for releases;
   increment `stateSchemaVersion` when the DUYA-managed App instance schema
   changes.
2. Implement the App UI under `apps/`. It has no Electron preload and calls
   only the `duya.plugin-app` `bind` and `invoke` message protocol. Every tool
   it invokes must appear in `requiredCapabilities` and `capabilityTools`.
3. Implement the MCP tool handlers in the plugin. Declare the server in
   `mcp/servers.json`, use `${DUYA_PLUGIN_ROOT}` for code and
   `${DUYA_PLUGIN_DATA}` for persistent data. Keep server names and tool names
   in `capabilityTools` identical to the live MCP declarations. Treat the App
   and agent as separate processes; use the MCP service as the shared data
   boundary rather than keeping App-only in-memory state.
4. Declare read/write permissions in `permissions/policy.json`. Validate MCP
   arguments and protect shared writes inside the plugin service.
5. From a terminal connected to DUYA, install the copied plugin directory:
   `duya plugin install --from-path <plugin-directory> --yes`. `--yes` is
   required for non-interactive CLI use. The plugin's App launcher appears on
   its row in Settings → Capabilities → Plugins. Open the App and grant its
   declared tool scope when DUYA asks. An agent run can use the plugin MCP
   tools after the normal tool approval.

6. To update a local plugin, keep its plugin ID and data directory, increment
   `version`, make the changes in the source directory, and run the same
   install command again. DUYA replaces the installed package and invalidates
   open App sessions so the UI reloads. The `${DUYA_PLUGIN_DATA}` directory is
   retained across these installs. If the App's durable instance schema
   changes, increment `stateSchemaVersion` as well.

The copied project's MCP server can be checked without a DUYA desktop build
with `node --test test/template.test.cjs` from the project directory.
Update this plugin in its own directory or repository. DUYA's generic App
host handles package loading, lifecycle, approval, and scoped tool invocation.
