# Standalone Mini App plugin template

Copy this directory to your own plugin project. Change the plugin ID, name,
App ID, capability ID, tool names, and UI. Keep the matching declarations in
`.duya-plugin/plugin.json`, `mcp/servers.json`, and `permissions/policy.json`.
The `apps/notes/index.html` page communicates only through the generic
`duya.plugin-app` `bind` / `invoke` message protocol; it has no DUYA preload or
Canvas-specific IPC dependency.

Use DUYA Desktop **Settings → Plugins → Install Local** to select the copied
directory. The installed plugin's App appears in the plugin App launcher. An
agent run can call the same plugin MCP tools after the normal tool approval.

The App and the agent use separate MCP processes. The example's `server.cjs`
shares notes through `${DUYA_PLUGIN_DATA}/notes.json` and a cross-process file
lock. Keep this property if your App and agent both edit the same data.

On every App launch DUYA resolves the installed manifest, asks for the App's
declared tool capability, starts the scoped MCP service, and binds only the
allowed tools. The App must tolerate updates or permission revocation by
reconnecting when its host session changes.

This template needs a DUYA version with `runtime: "standalone"` support (the
generic host changes in DUYA draft PR #355). It demonstrates the plugin
boundary; it does not validate the current desktop build end to end.
