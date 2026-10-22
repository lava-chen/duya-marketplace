---
name: create-mini-app
description: Create an installable standalone DUYA desktop Mini App plugin with plugin-owned UI, MCP tools, and data. Use when a user asks the agent to build a new desktop App plugin.
---

# Create a DUYA Mini App plugin

The installed `app-builder` package includes a working scaffold at
`templates/standalone-mini-app`. Copy that directory into the user's chosen
project, then adapt it. Never modify DUYA core to implement an individual App.

1. Pick a stable, unique reverse-domain plugin ID and App ID. Change the
   manifest in the copied `.duya-plugin/plugin.json`.
2. Implement the App UI under `apps/`. It has no Electron preload and calls
   only the `duya.plugin-app` `bind` and `invoke` message protocol. Every tool
   it invokes must appear in `requiredCapabilities` and `capabilityTools`.
3. Implement the MCP tool handlers in the plugin. Declare the server in
   `mcp/servers.json`, use `${DUYA_PLUGIN_ROOT}` for code and
   `${DUYA_PLUGIN_DATA}` for persistent data. Keep tool names and server names
   identical in the manifest. Treat the App and agent as separate processes.
4. Declare read/write permissions in `permissions/policy.json`. Validate MCP
   arguments and protect shared writes inside the plugin service.
5. Ask DUYA Desktop to install the local plugin directory through the Plugins
   settings. Open its App from the plugin App launcher. Confirm that both the
   App and an agent run can use its MCP tools and see the same data.

Update this plugin in its own directory or repository. DUYA's generic App
host handles install, lifecycle, approval, and scoped tool invocation.
