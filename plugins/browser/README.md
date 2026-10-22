# DUYA Browser

DUYA Browser exposes the browser control plane as the `cua_repl` MCP server.
Its JavaScript context persists for the lifetime of the MCP connection.

## Tools

- `js({ code, timeout_ms?, title? })` runs JavaScript in the persistent CUA
  context. After startup or reset, one call must contain only
  `await cua.getApiDocs()`; the next call must contain only
  `await cua.getState()`. Read state in a separate call after switching
  targets or active tabs. The server rejects browser actions in the same call
  that reads state.
- `js_add_node_module_dir({ path })` adds an absolute `node_modules` directory
  to the REPL's module search path.
- `js_reset()` clears the JavaScript context and repeats the initialization
  requirement. It leaves browser tabs and their state open.

The CUA bridge supports DUYA's agent webview and the connected Chrome or Edge
extension. DUYA webview tabs opened by the plugin are isolated agent tabs.
System-browser tabs can be selected by ID or exact URL and attached to this
plugin session; closing the CUA session detaches from attached tabs without
closing them.

The CUA API also supports listing, opening, switching, and closing tabs.
Closing an attached system-browser tab releases the attachment; it does not
close the user's tab.

The plugin calls DUYA's local browser daemon. Keep the DUYA desktop app running.
For Chrome or Edge, install the Browser Bridge shipped in this plugin:

1. Open the browser's extension management page and enable Developer mode.
2. Choose **Load unpacked** and select this plugin's `extension/` directory.
3. Keep the extension connected to the DUYA desktop app. The extension in
   DUYA's old one-click installer is version 1.5.8 and lacks `tabs.available`
   and `tabs.attach`; use this plugin's version 1.5.9 for existing-tab control.

The plugin owns the extension's source and its attached-tab behavior. DUYA's
legacy extension and daemon remain installed for compatibility during migration;
the Browser MCP service still depends on the daemon and is not yet a fully
independent browser implementation. MCP tool approval is governed by DUYA's
plugin MCP approval flow.
